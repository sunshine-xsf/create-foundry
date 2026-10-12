"""用户阅读报告：固定 22 列、带本地日期的 CSV / JSON；XLSX 可选。

此模块不登录 Azure。客户端密码/令牌永不进入报告；仅明确授权导出的资源
API key 暂存内存，并且只写成功结果的“密钥”列。内部诊断报告仍全部脱敏。
"""
from __future__ import annotations

import csv
import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

from foundry_excel import INFO_COLUMNS, sheet_xml, write_workbook

# 顺序对应用户截图；CSV 第一行、JSON 每条记录和 Excel 使用同一份定义。
RESULT_FIELDS = [
    ("订阅名称", "subscription_name", 30), ("订阅ID", "subscription_id", 42),
    ("资源组", "resource_group", 30), ("区域", "location", 22),
    ("Foundry资源名称", "account_name", 38), ("Foundry项目名称", "project_name", 30),
    ("部署名称", "deployment_name", 30), ("模型名称", "model_name", 26),
    ("模型版本", "resolved_model_version", 22), ("模型格式", "model_format", 18),
    ("SKU", "sku_name", 24), ("TPM", "tpm", 18), ("容量(capacity)", "capacity", 20),
    ("密钥", "api_key", 48), ("Endpoint", "endpoint", 64),
    ("Account Endpoint", "account_endpoint", 64), ("Azure OpenAI端点", "azure_openai_endpoint", 64),
    ("项目资源ID", "project_resource_id", 90), ("RAI策略", "rai_policy", 30),
    ("流式过滤模式", "streaming_filter_mode", 26), ("状态", "status", 22), ("错误", "error", 80),
]
CSV_FIELDS = [label for label, _, _ in RESULT_FIELDS]
SUCCESS = {"created", "updated", "unchanged"}
NOTES = {
    "TPM": "仅使用服务明确返回的每分钟 token 限制；未知留空，不按 capacity 猜算。",
    "密钥": "敏感：Foundry 资源 API key，不是客户端密码。禁用或无权限时为空。",
    "Endpoint": "Azure 返回的项目端点；多个端点无法唯一选择时保存原映射。",
    "状态": "created=新建；updated=更新；unchanged=已存在且一致；failed/auth_failed/config_failed=失败；not_run=未执行；interrupted/unknown=结果待核实，不等同失败；starting/running=进行中；planned=离线预览。",
    "错误": "部署/配置错误；详情读取警告另见 JSON report_warnings 和 Excel 运行说明。",
    "模型版本": "成功时为实际解析版本；离线预览时可能为空。",
    "流式过滤模式": "仅读取现有策略，不修改内容过滤设置。",
}


class ReportExporter:
    def __init__(self, output: Path, *, include_api_keys: bool = False, started_at=None, stem: str | None = None, include_xlsx: bool = True):
        self.output = Path(output)
        self.started_at = started_at or datetime.now().astimezone()
        if stem is not None and not re.fullmatch(r"results_[A-Za-z0-9_-]{1,100}", stem):
            raise ValueError("报告名称无效")
        self.stem = stem or ("results_" + self.started_at.strftime("%Y-%m-%d_%H%M%S_%f") + "_" + uuid.uuid4().hex[:6])
        self.include_xlsx = include_xlsx
        self.include_api_keys = include_api_keys
        self._keys: dict[str, str] = {}

    def path(self, suffix: str) -> Path:
        return self.output / (self.stem + suffix)

    def remember_api_key(self, deployment_id: str, value: str) -> bool:
        """授权只针对这一专列；已知客户端密码或访问令牌不能冒充资源 key 导出。"""
        from deploy_foundry import redact
        if not self.include_api_keys or not deployment_id or not isinstance(value, str) or not value:
            return False
        if value not in self._keys.values() and redact(value, limit=None) != value:
            return False
        self._keys[deployment_id] = value
        return True

    def write(self, report: dict) -> None:
        """输入必须是核心已脱敏报告；每次进度使用同名文件，重复运行使用新名字。"""
        from deploy_foundry import csv_safe
        self.output.mkdir(parents=True, exist_ok=True)
        records = []
        warnings = list(report.get("report_warnings", []))
        for row in report.get("deployments", []):
            record = {label: row.get(key, "") for label, key, _ in RESULT_FIELDS}
            record["模型版本"] = row.get("resolved_model_version") or row.get("model_version", "")
            # 失败/待执行/预览不输出 key；恢复中断报告时从内存保留已成功条目的 key。
            record["密钥"] = (self._keys.get(row.get("deployment_resource_id", ""), "")
                              if self.include_api_keys and row.get("status") in SUCCESS else "")
            records.append(record)
            for warning in row.get("report_warnings", []):
                warnings.append(str(row.get("deployment_name", "")) + ": " + warning)
        exported = {key: value for key, value in report.items() if key not in {"deployments", "report_warnings"}}
        exported.update(report_date=self.started_at.strftime("%Y-%m-%d"),
                        started_at_local=self.started_at.isoformat(), columns=CSV_FIELDS,
                        contains_resource_api_keys=any(row["密钥"] for row in records),
                        report_warnings=list(dict.fromkeys(warnings)), deployments=records)
        self._write_json(exported)
        temporary = self.path(".csv.tmp")
        with temporary.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows({key: csv_safe(value) for key, value in row.items()} for row in records)
        temporary.replace(self.path(".csv"))
        if not self.include_xlsx:
            return
        columns = [(label, label, NOTES.get(label, "Azure 实际结果 / 部署计划"), width)
                   for label, _, width in RESULT_FIELDS]
        notes = [
            {"item": "运行模式", "description": "离线预览，没有部署资源" if report["mode"] == "dry-run" else "实际部署；逐条查看状态与错误"},
            {"item": "报告本地时间", "description": self.started_at.isoformat()},
            {"item": "状态汇总", "description": report.get("summary", {})},
            {"item": "敏感文件", "description": "密钥列可能含资源 API key，请勿上传代码仓库或发送给无关人员。客户端密码和令牌不导出。"},
        ] + [{"item": "报告警告", "description": warning} for warning in exported["report_warnings"]]
        try:
            write_workbook(self.path(".xlsx"), [("部署结果", sheet_xml(columns, records, status_colors=True)),
                                               ("运行说明", sheet_xml(INFO_COLUMNS, notes, freeze_columns=0))])
        except OSError:
            warning = "格式化 Excel 无法写入；请关闭占用文件，当前 CSV/JSON 仍可查看。"
            exported["report_warnings"].append(warning)
            self._write_json(exported)
            print("警告：" + warning, file=sys.stderr)

    def _write_json(self, report: dict) -> None:
        temporary = self.path(".json.tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path(".json"))
