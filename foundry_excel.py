#!/usr/bin/env python3
"""截图风格的 Excel 模板与报告（Python 标准库，无需安装导出依赖）。

.xlsx 使用 ZIP + SpreadsheetML。仅输出数据/样式，不写公式、宏、外部链接；
所有字符串按 inlineStr 保存，避免版本号变成日期或错误文本被执行为公式。
读取用户 Excel 仍由核心脚本的 openpyxl 处理，本模块仅负责生成。
"""
from __future__ import annotations

import json
import math
import re
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("", NS)
ET.register_namespace("r", REL)

# 顺序对齐截图：D 资源组、E Foundry 账号、F 项目、G 部署名、H 版本、I 格式、J SKU。
# 每列：程序字段、可读表头、填写说明、列宽。
PLAN_COLUMNS = [
    ("subscription_id", "Subscription Id *", "必填 · Azure 订阅 ID\n凭据只填 JSON，不填本表", 39),
    ("location", "Foundry Region *", "必填 · 区域代码或中文别名\n例如 swedencentral / 瑞典中部", 28),
    ("model_name", "Model Name *", "必填 · 模型名称\n以实际模型目录为准", 28),
    ("resource_group", "Resource Group", "选填 · 留空自动生成", 28),
    ("account_name", "Foundry Resource Name", "选填 · 留空生成稳定名称\n复用已有资源时填其名称", 36),
    ("project_name", "Foundry Project Name", "选填 · 留空使用 default-project", 36),
    ("deployment_name", "Deployment Name", "选填 · 留空使用模型名", 28),
    ("model_version", "Model Version", "选填 · 新建选唯一默认版本\n复用已有部署时保留原版本", 28),
    ("model_format", "Model Format", "选填 · 默认 OpenAI", 20),
    ("sku_name", "SKU Name", "选填 · 默认 GlobalStandard", 26),
    ("capacity", "Capacity", "选填 · 默认 1，必须为正整数\n不是统一固定的 TPM 数值", 29),
    ("rai_policy_name", "Content Filter", "选填 · 目标账号已有的内容筛选器名称\n留空使用 Azure 默认/保留已有策略", 30),
    ("project_display_name", "Project Display Name", "选填 · 留空使用项目名", 30),
    ("project_description", "Project Description", "选填 · 项目描述\n仅新建项目时设置", 42),
]
RESULT_COLUMNS = PLAN_COLUMNS + [
    ("status", "Status / 部署状态", "成功：created / updated / unchanged\n预览：planned；失败请看 Error", 34),
    ("resolved_model_version", "Resolved Model Version", "实际解析的模型版本\n未请求 Azure 时可能为空", 28),
    ("account_endpoint", "Account Endpoint", "服务返回的账号端点\n不包含 API key", 55),
    ("project_endpoints", "Project Endpoints", "服务返回的项目端点\n多值按 JSON 展示", 60),
    ("quota_check", "Quota Check / 配额检查", "本次配额检查结果\n离线预览不检查实际配额", 48),
    ("error", "Error / 错误原因", "失败时请查看此列\n客户端密码、访问令牌已脱敏", 72),
    ("account_resource_id", "Account Resource ID", "Foundry 账号的资源 ID", 64),
    ("project_resource_id", "Project Resource ID", "Foundry 项目的资源 ID", 64),
    ("deployment_resource_id", "Deployment Resource ID", "模型部署的资源 ID", 64),
]
STATUS_HELP = {
    "starting": "已启动，正在读取配置", "pending": "尚未处理", "running": "正在处理，不能视为成功",
    "planned": "仅离线预览，没有部署资源", "created": "创建成功", "updated": "更新成功",
    "unchanged": "已有配置一致，未修改", "failed": "部署/运行失败，请查看 Error",
    "config_failed": "配置错误", "auth_failed": "认证失败", "interrupted": "已中断，云端任务可能继续",
}


def element(parent, name, attributes=None, namespace=NS):
    return ET.SubElement(parent, "{" + namespace + "}" + name, attributes or {})


def xml_bytes(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def column_letter(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    # XML 1.0 不允许的控制字符/孤立代理字符不能进入工作簿；JSON 原报告不截断。
    value = re.sub(r"[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]", "", str(value))
    if len(value) > 32767:
        value = value[:32730] + "…（完整内容请查看 JSON 报告）"
    return value


def styles_xml():
    root = ET.Element("{" + NS + "}styleSheet")
    fonts = element(root, "fonts", {"count": "6"})
    for color, bold, italic in [("243746", False, False), ("FFFFFF", True, False),
                                ("315E8B", False, True), ("17613D", True, False),
                                ("9C2430", True, False), ("855B12", True, False)]:
        font = element(fonts, "font")
        element(font, "sz", {"val": "11"})
        element(font, "color", {"rgb": "FF" + color})
        element(font, "name", {"val": "Microsoft YaHei"})
        if bold:
            element(font, "b")
        if italic:
            element(font, "i")
    fills = element(root, "fills", {"count": "8"})
    for pattern, color in [("none", ""), ("gray125", ""), ("solid", "19385C"),
                           ("solid", "D9EAF7"), ("solid", "F3F7FB"),
                           ("solid", "E2F0D9"), ("solid", "FCE4D6"), ("solid", "FFF2CC")]:
        fill = element(fills, "fill")
        pattern_fill = element(fill, "patternFill", {"patternType": pattern})
        if color:
            element(pattern_fill, "fgColor", {"rgb": "FF" + color})
            element(pattern_fill, "bgColor", {"indexed": "64"})
    borders = element(root, "borders", {"count": "2"})
    for thin in (False, True):
        border = element(borders, "border")
        for side in ("left", "right", "top", "bottom", "diagonal"):
            edge = element(border, side, {"style": "thin"} if thin and side != "diagonal" else {})
            if thin and side != "diagonal":
                element(edge, "color", {"rgb": "FFB8CADA"})
    bases = element(root, "cellStyleXfs", {"count": "1"})
    element(bases, "xf", {"numFmtId": "0", "fontId": "0", "fillId": "0", "borderId": "0"})
    xfs = element(root, "cellXfs", {"count": "9"})
    # 0 默认；1 深蓝表头；2 浅蓝说明；3/4 隔行文本；5/6/7 状态；8 数字。
    for font, fill, fmt, center in [(0, 0, 0, False), (1, 2, 49, True), (2, 3, 49, False),
                                    (0, 0, 49, False), (0, 4, 49, False), (3, 5, 49, True),
                                    (4, 6, 49, True), (5, 7, 49, True), (0, 0, 0, True)]:
        xf = element(xfs, "xf", {"numFmtId": str(fmt), "fontId": str(font), "fillId": str(fill),
                                  "borderId": "1", "xfId": "0", "applyAlignment": "1", "applyNumberFormat": "1"})
        element(xf, "alignment", {"horizontal": "center" if center else "left", "vertical": "center", "wrapText": "1"})
    named = element(root, "cellStyles", {"count": "1"})
    element(named, "cellStyle", {"name": "Normal", "xfId": "0", "builtinId": "0"})
    return xml_bytes(root)


def sheet_xml(columns, records, *, status_colors=False, freeze_columns=3, validations=False):
    if len(records) > 1048574 or not columns or len(columns) > 16384:
        raise ValueError("超出 Excel 工作表行列限制")
    root = ET.Element("{" + NS + "}worksheet")
    end = column_letter(len(columns))
    element(root, "dimension", {"ref": f"A1:{end}{len(records) + 2}"})
    view = element(element(root, "sheetViews"), "sheetView", {"workbookViewId": "0", "showGridLines": "0", "zoomScale": "85"})
    top_left = column_letter(freeze_columns + 1) + "3"
    pane = {"ySplit": "2", "topLeftCell": top_left, "activePane": "bottomRight" if freeze_columns else "bottomLeft", "state": "frozen"}
    if freeze_columns:
        pane["xSplit"] = str(freeze_columns)
    element(view, "pane", pane)
    element(view, "selection", {"pane": pane["activePane"], "activeCell": top_left, "sqref": top_left})
    element(root, "sheetFormatPr", {"defaultRowHeight": "28"})
    widths = element(root, "cols")
    for index, column in enumerate(columns, 1):
        element(widths, "col", {"min": str(index), "max": str(index), "width": str(column[3]), "customWidth": "1"})
    data = element(root, "sheetData")
    values = [[col[1] for col in columns], [col[2] for col in columns]]
    values.extend([[record.get(col[0], "") for col in columns] for record in records])
    for number, cells in enumerate(values, 1):
        row = element(data, "row", {"r": str(number), "ht": "32" if number == 1 else "56" if number == 2 else "54", "customHeight": "1"})
        for index, value in enumerate(cells, 1):
            style = number if number <= 2 else 3 + (number % 2 == 0)
            numeric = type(value) in (int, float) and abs(value) < 1e15 and math.isfinite(value)
            if number > 2 and numeric:
                style = 8
            if number > 2 and status_colors and columns[index - 1][0] in {"status", "状态"}:
                status = str(value)
                if status in {"created", "updated", "unchanged"}:
                    style = 5
                elif status in {"failed", "auth_failed", "config_failed", "interrupted"}:
                    style = 6
                elif status in {"planned", "running", "pending", "starting"}:
                    style = 7
            cell = element(row, "c", {"r": column_letter(index) + str(number), "s": str(style), "t": "n" if numeric else "inlineStr"})
            if numeric:
                element(cell, "v").text = str(value)
            else:
                element(element(cell, "is"), "t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"}).text = cell_text(value)
    # 保持第二行填写说明常驻，不把它混进筛选数据；此布局不创建 Excel Table。
    if validations:
        rules = element(root, "dataValidations", {"count": "2"})
        rule = element(rules, "dataValidation", {"type": "whole", "operator": "greaterThanOrEqual", "allowBlank": "1",
                         "showErrorMessage": "1", "errorTitle": "容量填写错误", "error": "请填写大于等于 1 的整数。", "sqref": "K3:K1048576"})
        element(rule, "formula1").text = "1"
        rule = element(rules, "dataValidation", {"type": "list", "allowBlank": "1", "showErrorMessage": "1",
                         "errorTitle": "请选择支持的 SKU", "sqref": "J3:J1048576"})
        element(rule, "formula1").text = '"GlobalStandard,Standard,DataZoneStandard"'
    element(root, "pageMargins", {"left": "0.25", "right": "0.25", "top": "0.4", "bottom": "0.4", "header": "0.2", "footer": "0.2"})
    element(root, "pageSetup", {"orientation": "landscape", "paperSize": "9"})
    return xml_bytes(root)


def write_workbook(path: Path, sheets):
    """单文件原子替换。失败不会覆盖旧文件，也不会影响已写出的 CSV/JSON。"""
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    types = ET.Element("{" + CT + "}Types")
    for suffix, content in [("rels", "application/vnd.openxmlformats-package.relationships+xml"), ("xml", "application/xml")]:
        element(types, "Default", {"Extension": suffix, "ContentType": content}, CT)
    for part, kind in [("workbook.xml", "sheet.main"), ("styles.xml", "styles")]:
        element(types, "Override", {"PartName": "/xl/" + part, "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml." + kind + "+xml"}, CT)
    workbook = ET.Element("{" + NS + "}workbook")
    element(element(workbook, "bookViews"), "workbookView", {"activeTab": "0"})
    items = element(workbook, "sheets")
    links = ET.Element("{" + PKG + "}Relationships")
    element(links, "Relationship", {"Id": "rIdStyles", "Type": REL + "/styles", "Target": "styles.xml"}, PKG)
    roots = ET.Element("{" + PKG + "}Relationships")
    element(roots, "Relationship", {"Id": "rId1", "Type": REL + "/officeDocument", "Target": "xl/workbook.xml"}, PKG)
    for index, (name, _) in enumerate(sheets, 1):
        element(items, "sheet", {"name": name, "sheetId": str(index), "{" + REL + "}id": f"rId{index}"})
        element(links, "Relationship", {"Id": f"rId{index}", "Type": REL + "/worksheet", "Target": f"worksheets/sheet{index}.xml"}, PKG)
        element(types, "Override", {"PartName": f"/xl/worksheets/sheet{index}.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"}, CT)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, payload in [("[Content_Types].xml", xml_bytes(types)), ("_rels/.rels", xml_bytes(roots)),
                                  ("xl/workbook.xml", xml_bytes(workbook)), ("xl/_rels/workbook.xml.rels", xml_bytes(links)),
                                  ("xl/styles.xml", styles_xml())]:
                archive.writestr(name, payload)
            for index, (_, payload) in enumerate(sheets, 1):
                archive.writestr(f"xl/worksheets/sheet{index}.xml", payload)
        temporary.replace(path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


INFO_COLUMNS = [("item", "Item / 项目", "说明项目", 36), ("description", "Description / 说明", "阅读说明，不作为部署配置", 110)]


def write_excel_report(path: Path, report: dict) -> None:
    """接收核心脚本已经脱敏的报告，只导出已知结果列，不接触 credentials。"""
    rows = report.get("deployments", [])
    notes = [
        {"item": "运行模式", "description": "离线预览 · 没有部署资源" if report["mode"] == "dry-run" else "实际部署 · 成败请查看每条 Status"},
        {"item": "更新时间（UTC）", "description": report.get("updated_at_utc", "")},
        {"item": "状态汇总", "description": report.get("summary", {})},
        {"item": "忽略的重复计划数", "description": report.get("duplicates_ignored", 0)},
        {"item": "阅读方式", "description": "第 1 行为字段，第 2 行为说明，第 3 行开始是数据。已冻结前两行和前三列，横向滚动查看后续列。"},
        {"item": "安全与限制", "description": "不导出客户端密码或令牌。读取时请勿另存覆盖原配置；JSON 保留完整数据，Excel 仅作阅读展示。"},
    ] + [{"item": key, "description": value} for key, value in STATUS_HELP.items()]
    write_workbook(path, [("部署结果", sheet_xml(RESULT_COLUMNS, rows, status_colors=True)),
                          ("运行说明", sheet_xml(INFO_COLUMNS, notes, freeze_columns=0))])


def write_excel_template(path: Path) -> None:
    """生成空白填写页 + 全零订阅示例页，不包含真实账号或凭据。"""
    sample = {"subscription_id": "00000000-0000-0000-0000-000000000000", "location": "swedencentral",
              "model_name": "gpt-4.1-mini", "model_format": "OpenAI", "sku_name": "GlobalStandard", "capacity": 1,
              "project_description": "仅格式示例，请替换订阅并核实模型可用性"}
    notes = [
        {"item": "日常一键部署", "description": "本 Excel 填部署计划；foundry.local.json 仅填三项登录凭据。保存并关闭 Excel 后双击部署.cmd。"},
        {"item": "Excel 批量计划（必填）", "description": "在部署计划页第 3 行开始每行填写一个模型。双击入口默认读取本文件的“部署计划”页，等待全部完成；需要 openpyxl。"},
        {"item": "必填项", "description": "Subscription Id、Foundry Region、Model Name。带 * 表头必填，其余可选。请勿删除前两行或改动表头。"},
        {"item": "凭据", "description": "不要把密码/令牌填入 Excel。在 JSON credentials 内填 AZURE_CLIENT_ID、AZURE_CLIENT_SECRET、AZURE_TENANT_ID。"},
        {"item": "示例页", "description": "仅演示格式，全零订阅不能真实部署。复制示例时必须替换订阅并核实区域、模型、SKU 和配额。"},
        {"item": "模型版本", "description": "按文本保存。留空不是保证最新版本：新建选择唯一默认版本；已有部署保留版本；不明确时需人工填写。"},
        {"item": "运行结果", "description": "output 文件夹生成 results_当天日期_时间_随机后缀.csv/.json/.xlsx。密钥列可能包含资源 API key，请保密；created/updated/unchanged 才表示成功。"},
    ]
    write_workbook(path, [("部署计划", sheet_xml(PLAN_COLUMNS, [{} for _ in range(20)], validations=True)),
                          ("填写示例", sheet_xml(PLAN_COLUMNS, [sample], validations=True)),
                          ("使用说明", sheet_xml(INFO_COLUMNS, notes, freeze_columns=0))])


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    # 只生成空白模板，不读取本地 JSON、不登录 Azure、不部署任何资源。
    target = Path(__file__).resolve().with_name("Foundry部署模板.xlsx")
    if target.exists():
        raise SystemExit("模板已存在；为避免覆盖填写内容，不自动重建。")
    write_excel_template(target)
    print(target)
