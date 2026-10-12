#!/usr/bin/env python3
"""真实部署执行入口：网页完整计划，或兼容的 Excel + JSON 入口。

默认实际部署并等待完成；--dry-run 仅离线检查。网页凭据通过 stdin 传入，
不会进入命令行或临时凭据文件。每批输出同名、带本地日期的 CSV / JSON；
兼容的 Excel 入口额外生成 XLSX。诊断和导出结果会脱敏。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import deploy_foundry as deploy
from foundry_results import ReportExporter


def record_failure(directory: Path, mode: str, status: str, message: str, *, exporter=None) -> None:
    """配置错误/意外失败也有报告；保留已经成功的条目，不虚报回滚。"""
    rows, duplicates = [], 0
    try:
        previous = json.loads((directory / "results.json").read_text(encoding="utf-8"))
        rows = previous.get("deployments", [])
        duplicates = previous.get("duplicates_ignored", 0)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        rows = []
    if status == "interrupted" and any(row.get("status") == "interrupted" for row in rows):
        return
    active = [row for row in rows if row.get("status") in {"starting", "running"}]
    if active:
        for row in active:
            row.update(status=status, error=deploy.redact(message))
    else:
        row = {key: "" for key in rows[0]} if rows else {}
        row.update(status=status, error=deploy.redact(message), report_warnings=[])
        rows.append(row)
    deploy.write_report(directory, rows, mode, duplicates, exporter=exporter)


def print_reports(exporter) -> None:
    for suffix, label in [(".json", "JSON"), (".csv", "CSV"), (".xlsx", "Excel")]:
        path = exporter.path(suffix)
        if suffix == ".xlsx" and not exporter.include_xlsx:
            continue
        print(label + " 报告：" + (str(path) if path.exists() else "未生成，请检查写入警告"), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Excel 部署计划 + JSON 登录凭据；默认实际部署 Foundry")
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().with_name("foundry.local.json"), help="登录凭据 JSON")
    parser.add_argument("--config-stdin", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output-dir", type=Path, help="报告输出目录；网页系统会指定本项目 output 文件夹")
    parser.add_argument("--report-stem", help=argparse.SUPPRESS)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--excel", type=Path, help="计划 Excel；默认与 JSON 同目录的 Foundry部署模板.xlsx")
    source.add_argument("--plan-json", action="store_true", help="从 JSON 读取完整计划；网页使用此模式")
    parser.add_argument("--sheet", default="部署计划", help="计划工作表；默认 部署计划，不读取填写示例页")
    parser.add_argument("--no-api-key", action="store_true", help="不读取/导出资源 API key")
    flags = parser.add_mutually_exclusive_group()
    flags.add_argument("--dry-run", action="store_true", help="不认证、不访问 Azure，仅预览")
    flags.add_argument("--apply", action="store_true", help="实际部署（默认行为）")
    args = parser.parse_args(argv)
    config = args.config.resolve()
    excel = args.excel.resolve() if args.excel else config.with_name("Foundry部署模板.xlsx")
    mode = "dry-run" if args.dry_run else "apply"
    directory = None
    temporary_workspace = None
    output_dir = args.output_dir.resolve() if args.output_dir else config.parent / "output"
    exporter = ReportExporter(output_dir, stem=args.report_stem, include_xlsx=not args.plan_json)
    print("=== Foundry 一键部署 ===", flush=True)
    print("模式：离线预览，不访问 Azure" if args.dry_run else "模式：实际部署，将创建云资源，可能产生费用", flush=True)
    try:
        # 部署过程会持续覆盖写入中间状态，放到系统临时目录而非 output。
        # 每批在 output 保留同名、带日期的 CSV / JSON 各一份；Excel 入口额外生成 XLSX。
        temporary_workspace = tempfile.TemporaryDirectory(prefix="foundry-run-")
        directory = Path(temporary_workspace.name)
        deploy.write_report(directory, [{"status": "starting", "error": ""}], mode, 0, exporter=exporter)
        if args.config_stdin and not args.plan_json:
            raise deploy.PlanError("标准输入配置仅支持网页完整计划")
        if not args.config_stdin and not config.is_file():
            raise deploy.PlanError("找不到配置文件；网页请通过双击部署.cmd 启动；Excel 入口请检查 foundry.local.json 路径")
        # 同一次读取传给核心认证；默认绝不回退使用 JSON 里的旧部署计划。
        document = json.loads(sys.stdin.read(1_000_001)) if args.config_stdin else deploy.read_json_document(config)
        if not isinstance(document, dict):
            raise deploy.PlanError("一键部署 JSON 必须是对象，请在 credentials 中填写三个 AZURE_ 字段")
        # 标准输入路径同样先登记秘密，后续错误或报告必须脱敏。
        for key, value in (document.get("credentials") or {}).items() if isinstance(document.get("credentials"), dict) else []:
            if "secret" in key.lower() or "token" in key.lower():
                deploy.remember_secret(value)
        deploy.validate_json_sections(document)
        if not args.dry_run and "credentials" not in document:
            raise deploy.PlanError("一键部署需要 JSON credentials，请填写三个 AZURE_ 凭据字段")
        options = document.get("run", {})
        exporter.include_api_keys = not (args.no_api_key or args.dry_run or args.plan_json) and options.get("export_api_key", False)
        if exporter.include_api_keys:
            print("提示：结果“密钥”列将尝试导出资源 API key；请把 output 按敏感文件保管。", flush=True)
        command = ["--dry-run" if args.dry_run else "--apply", "--auth", "service-principal"]
        if args.plan_json:
            command += ["--config", str(config), "--detailed-report"]
        else:
            if not excel.is_file():
                raise deploy.PlanError("找不到部署计划 Excel：" + str(excel))
            print("部署计划：" + str(excel) + " / " + args.sheet, flush=True)
            if "defaults" in document or "deployments" in document:
                print("提示：JSON 中旧的 defaults/deployments 不参与本次部署；以 Excel 为准。", flush=True)
            command += ["--excel", str(excel), "--sheet", args.sheet, "--detailed-report"]
        for key in sorted(deploy.RUN_FLAGS):
            # 新一键流程允许注册部署所需提供程序；旧 JSON 模式保持原默认。
            default = key == "register_provider" and not args.plan_json
            if options.get(key, default):
                command.append("--" + key.replace("_", "-"))
        # 并发数来自网页配置，核心 CLI 限制范围；Excel 入口默认保持串行。
        command += ["--max-concurrency", str(options.get("max_concurrency", 3))]
        code = deploy.main(command, config_document=document, run_directory=directory, report_exporter=exporter)
        if code == 130:
            record_failure(directory, mode, "interrupted", "用户中断；若请求已提交，Azure 端任务可能继续", exporter=exporter)
        print_reports(exporter)
        if code == 0:
            print("离线预览完成（没有部署资源）。" if args.dry_run else "部署完成：所有条目成功或配置未变更；详情读取警告见 JSON report_warnings。", flush=True)
        else:
            print("本次未全部成功，请查看报告中的“状态”和“错误”。", flush=True)
        temporary_workspace.cleanup()
        temporary_workspace = None
        return code
    except KeyboardInterrupt:
        status, message, code = "interrupted", "用户中断；Azure 端任务可能继续，请检查资源状态", 130
    except (deploy.PlanError, deploy.DeployError, OSError, ValueError) as exc:
        status, message, code = "config_failed", deploy.redact(str(exc)), 2
    except Exception as exc:
        status, message, code = "failed", f"未预期的程序异常（{type(exc).__name__}）；请检查配置或联系维护人员", 2
    print("错误：" + message, file=sys.stderr, flush=True)
    if directory is not None:
        try:
            record_failure(directory, mode, status, message, exporter=exporter)
            print_reports(exporter)
        except OSError:
            print("报告目录无法写入，请检查文件占用、磁盘空间与目录权限。", file=sys.stderr)
    if temporary_workspace is not None:
        temporary_workspace.cleanup()
    return code


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())

