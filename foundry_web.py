#!/usr/bin/env python3
"""本机 Foundry 批量部署控制台。

浏览器仅连接 http://127.0.0.1:8765；服务主体（SP）凭据由页面 POST 到本机进程，
仅写入一次性临时 JSON，部署结束后立即删除。凭据绝不写进 output、日志或网页接口响应。
真实 Azure 部署仍完全由 run_foundry.py / deploy_foundry.py 执行。
"""
from __future__ import annotations

import json
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
import urllib.error
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import deploy_foundry as deploy
import foundry_plan as console_plan

BASE_DIR = Path(__file__).resolve().parent
PAGE_FILE = BASE_DIR / "Foundry部署控制台.html"
RUNNER_FILE = BASE_DIR / "run_foundry.py"
OUTPUT_DIR = BASE_DIR / "output"
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY_BYTES = 1_000_000
SUBSCRIPTION_API = "2022-12-01"

# 网页表格字段与核心部署脚本识别的 Excel 列头一一对应。
PLAN_COLUMNS = [
    ("subscription_id", "Subscription Id *"),
    ("location", "Foundry Region *"),
    ("model_name", "Model Name *"),
    ("resource_group", "Resource Group"),
    ("account_name", "Foundry Resource Name"),
    ("project_name", "Foundry Project Name"),
    ("deployment_name", "Deployment Name"),
    ("model_version", "Model Version"),
    ("model_format", "Model Format"),
    ("sku_name", "SKU Name"),
    ("capacity", "Capacity"),
    ("rai_policy_name", "Content Filter"),
    ("project_display_name", "Project Display Name"),
    ("project_description", "Project Description"),
    ("resource_group_mode", "Resource Group Mode"),
    ("account_mode", "Account Mode"),
    ("project_mode", "Project Mode"),
]
PLAN_KEYS = {key for key, _ in PLAN_COLUMNS}
RUN_KEYS = {"register_provider", "update_existing", "skip_quota_check"}
GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
# Azure AI Foundry 账号名：2~64 位小写字母、数字、连字符，首尾必须为字母或数字。
FOUNDRY_ACCOUNT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
DOWNLOAD_RE = re.compile(r"^results_[A-Za-z0-9_-]+\.(?:csv|json|xlsx)$")


class RequestError(ValueError):
    """表示页面输入错误；消息可以安全展示给操作者。"""


def clean_text(value: Any, label: str, *, required: bool = False, limit: int = 500) -> str:
    """将页面文本转为安全的普通字符串，不接受对象、数组或过长数据。"""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise RequestError(f"{label} 必须是文本")
    value = value.strip()
    if len(value) > limit:
        raise RequestError(f"{label} 过长，请缩短后重试")
    if required and not value:
        raise RequestError(f"请填写 {label}")
    return value


def require_guid(value: Any, label: str) -> str:
    value = clean_text(value, label, required=True, limit=64)
    if not GUID_RE.fullmatch(value):
        raise RequestError(f"{label} 格式不正确，请填写标准 GUID")
    return str(uuid.UUID(value))


def validate_credentials(raw: Any) -> dict[str, str]:
    """仅验证 SP 三项输入；不保存到项目目录。"""
    if not isinstance(raw, dict) or set(raw) - {"AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"}:
        raise RequestError("SP 凭据字段不正确")
    # Secret 是不透明的凭据：不要 strip()/规范化；空格或引号也可能属于真实密钥。
    secret = raw.get("AZURE_CLIENT_SECRET")
    if not isinstance(secret, str) or not secret or not secret.strip():
        raise RequestError("请填写 Client Secret（值）")
    if len(secret) > 2048:
        raise RequestError("Client Secret（值）过长，请核对后重试")
    return {
        "AZURE_CLIENT_ID": require_guid(raw.get("AZURE_CLIENT_ID"), "应用程序（客户端）ID"),
        "AZURE_CLIENT_SECRET": secret,
        "AZURE_TENANT_ID": require_guid(raw.get("AZURE_TENANT_ID"), "Microsoft Entra 租户 ID"),
    }


def validate_plan(raw: Any) -> list[dict[str, str]]:
    """验证批量部署表格，每一行都是一个真实 Azure 部署目标。"""
    if not isinstance(raw, list) or not raw:
        raise RequestError("至少需要添加一条模型部署计划")
    if len(raw) > 100:
        raise RequestError("单次最多部署 100 条模型计划")
    plan: list[dict[str, str]] = []
    for row_number, raw_row in enumerate(raw, 1):
        if not isinstance(raw_row, dict) or set(raw_row) - PLAN_KEYS:
            raise RequestError(f"第 {row_number} 行包含无法识别的字段")
        row = {key: clean_text(raw_row.get(key), f"第 {row_number} 行 {label}", limit=1000)
               for key, label in PLAN_COLUMNS}
        row["subscription_id"] = require_guid(row["subscription_id"], f"第 {row_number} 行 Azure 订阅 ID")
        for key, label in (("location", "部署区域"), ("model_name", "模型名称")):
            if not row[key]:
                raise RequestError(f"请填写第 {row_number} 行 {label}")
        # 与核心脚本一致：空值时使用这些安全默认值，其他字段仍可留空。
        row["model_format"] = row["model_format"] or "OpenAI"
        row["sku_name"] = row["sku_name"] or "GlobalStandard"
        row["capacity"] = row["capacity"] or "1"
        if not row["capacity"].isdigit() or int(row["capacity"]) < 1:
            raise RequestError(f"第 {row_number} 行 Capacity 必须是正整数")
        # 空值由核心脚本生成符合 Azure 规则的账号名；填写时先在网页接口校验，避免启动任务后才报错。
        if row["account_name"] and not FOUNDRY_ACCOUNT_RE.fullmatch(row["account_name"]):
            invalid_account = row["account_name"]
            raise RequestError(
                f"第 {row_number} 条计划的 Foundry 资源名“{invalid_account}”无效："
                "仅允许 2~64 位小写字母、数字和连字符（-），首尾必须是字母或数字；"
                "留空可由系统自动生成。"
            )
        plan.append(row)
    return plan


def validate_options(raw: Any) -> dict[str, bool | int]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict) or set(raw) - (RUN_KEYS | {"max_concurrency"}):
        raise RequestError("部署选项不正确")
    options: dict[str, bool] = {}
    for key in RUN_KEYS:
        value = raw.get(key, key == "register_provider")
        if not isinstance(value, bool):
            raise RequestError("部署选项必须为 true 或 false")
        options[key] = value
    workers = raw.get("max_concurrency", 2)
    if type(workers) is not int or not 1 <= workers <= 4:
        raise RequestError("并发数必须为 1–4 的整数")
    options["max_concurrency"] = workers
    return options

RESOURCE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._()\-]{0,127}$")


def require_resource_segment(value: Any, label: str) -> str:
    """校验资源组/资源名为单段 ARM 标识，防止页面参数改变 ARM 路径。"""
    value = clean_text(value, label, required=True, limit=128)
    if not RESOURCE_SEGMENT_RE.fullmatch(value):
        raise RequestError(f"{label} 格式不正确")
    return value


def require_group_name(value: Any) -> str:
    """与部署计划的资源组命名规则一致，支持合法的非 ASCII 资源组名。"""
    name = clean_text(value, "资源组", required=True, limit=90)
    if not re.fullmatch(r"[\w().-]{1,90}", name) or name.endswith("."):
        raise RequestError("资源组名称格式不正确")
    return name


def resource_group_from_id(resource_id: Any) -> str:
    parts = str(resource_id or "").strip("/").split("/")
    for index, part in enumerate(parts[:-1]):
        if part.casefold() == "resourcegroups":
            return parts[index + 1]
    return ""


def list_accessible_subscriptions(credentials: dict[str, str]) -> list[dict[str, str]]:
    """使用 SP 读取全部可访问订阅；不会创建、修改或保存 Azure 资源。"""
    token = deploy.TokenProvider("service-principal", credentials=credentials).get("")
    url = deploy.ARM + "/subscriptions?api-version=" + SUBSCRIPTION_API
    opener = urllib.request.build_opener(
        deploy.NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    while url:
        # nextLink 只能是 Azure Resource Manager 地址，避免把 Bearer Token 发送给其他地址。
        if not url.startswith(deploy.ARM + "/") or url in seen:
            raise RequestError("Azure 返回的订阅分页地址无效")
        seen.add(url)
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        try:
            with opener.open(request, timeout=60) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read())
                message = body.get("error", {}).get("message", "") if isinstance(body, dict) else ""
            except (ValueError, OSError):
                message = ""
            finally:
                exc.close()
            raise RequestError("无法读取 SP 可访问订阅：" + deploy.redact(str(message) or f"HTTP {exc.code}")) from None
        except (urllib.error.URLError, OSError, ValueError):
            raise RequestError("无法读取 SP 可访问订阅，请检查网络和 SP 的订阅读取权限") from None
        values = payload.get("value", []) if isinstance(payload, dict) else []
        if not isinstance(values, list):
            raise RequestError("Azure 返回的订阅列表格式无效")
        for item in values:
            if not isinstance(item, dict):
                continue
            subscription_id = str(item.get("subscriptionId") or "").strip()
            if not GUID_RE.fullmatch(subscription_id):
                continue
            result.append({
                "subscription_id": str(uuid.UUID(subscription_id)),
                "display_name": clean_text(item.get("displayName"), "订阅显示名称", limit=300),
                "state": clean_text(item.get("state"), "订阅状态", limit=80),
                "tenant_id": clean_text(item.get("tenantId"), "订阅租户 ID", limit=80),
            })
        next_link = payload.get("nextLink") if isinstance(payload, dict) else ""
        url = str(next_link).strip() if next_link else ""
    return sorted(result, key=lambda item: (item["display_name"].casefold(), item["subscription_id"]))

def lookup_subscription(credentials: dict[str, str], subscription_id: str) -> dict[str, Any]:
    """先读取资源组；Provider / Foundry 账号无权限时仍返回已读到的组。"""
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    try:
        # 与 Cognitive Services 的读取权限无关；ARM list() 已处理 nextLink 分页。
        groups = client.list(f"/subscriptions/{subscription_id}/resourcegroups", api=deploy.RESOURCE_API)
    except deploy.ArmError as exc:
        if exc.status == 403:
            raise RequestError(
                "无法列出此订阅的资源组（HTTP 403）。请核对目标订阅 ID，并确认 SP 在该订阅有"
                " Microsoft.Resources/subscriptions/resourceGroups/read 权限；仅有资源组级权限不能列出整个订阅的资源组。"
            ) from None
        raise RequestError("读取此订阅的资源组失败：" + deploy.redact(str(exc))) from None
    except deploy.DeployError as exc:
        raise RequestError("读取此订阅的资源组失败：" + deploy.redact(str(exc))) from None

    group_items = [{
        "name": str(item.get("name") or ""),
        "location": str(item.get("location") or ""),
    } for item in groups if isinstance(item, dict) and item.get("name")]
    warnings: list[str] = []
    try:
        subscription = client.get(f"/subscriptions/{subscription_id}", api=SUBSCRIPTION_API) or {}
    except deploy.DeployError as exc:
        subscription = {}
        warnings.append("订阅详情读取失败：" + deploy.redact(str(exc)))
    try:
        provider = client.get(f"/subscriptions/{subscription_id}/providers/Microsoft.CognitiveServices", api=deploy.PROVIDER_API) or {}
    except deploy.DeployError as exc:
        provider = {}
        warnings.append("Provider 状态读取失败：" + deploy.redact(str(exc)))
    try:
        accounts = client.list(f"/subscriptions/{subscription_id}/providers/Microsoft.CognitiveServices/accounts")
    except deploy.DeployError as exc:
        accounts = []
        warnings.append("Foundry 账号读取失败：" + deploy.redact(str(exc)))
    account_items = [{
        "name": str(item.get("name") or ""),
        "resource_group": resource_group_from_id(item.get("id")),
        "location": str(item.get("location") or ""),
        "kind": str(item.get("kind") or ""),
        "allow_project_management": (item.get("properties") or {}).get("allowProjectManagement") is True,
        "provisioning_state": str((item.get("properties") or {}).get("provisioningState") or ""),
        "endpoint": str((item.get("properties") or {}).get("endpoint") or ""),
    } for item in accounts if isinstance(item, dict) and item.get("name")]
    # 只有成功读取资源组后才能清理待删除标记。
    with _DELETE_LOCK:
        current = {item["name"].casefold() for item in group_items}
        _DELETE_PENDING.difference_update({key for key in _DELETE_PENDING
                                          if key[0] == subscription_id and key[1] not in current})
    account_items.sort(key=lambda item: (item["resource_group"].casefold(), item["name"].casefold()))
    group_items.sort(key=lambda item: item["name"].casefold())
    return {
        "subscription": {
            "id": subscription_id,
            "display_name": str(subscription.get("displayName") or ""),
            "state": str(subscription.get("state") or ""),
            "tenant_id": str(subscription.get("tenantId") or ""),
        },
        "provider_state": str(provider.get("registrationState") or "Unknown"),
        "resource_groups": group_items,
        "foundry_accounts": account_items,
        "warnings": warnings,
    }


# 删除资源组需要服务端预览和二次确认；令牌只在内存中，不保存 SP 密钥。
_DELETE_PREVIEWS: dict[str, dict[str, Any]] = {}
_DELETE_LOCK = threading.RLock()
_DELETE_PENDING: set[tuple[str, str]] = set()


def group_path(subscription_id: str, resource_group: str) -> str:
    return f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}"


def group_resources(client: deploy.ArmClient, path: str) -> list[dict[str, str]]:
    resources = client.list(path + "/resources", api=deploy.RESOURCE_API)
    return sorted(({"id": str(item.get("id") or ""), "name": str(item.get("name") or ""),
                    "type": str(item.get("type") or "")}
                   for item in resources if isinstance(item, dict)), key=lambda item: item["id"].casefold())


def preview_delete_group(credentials: dict[str, str], subscription_id: str, resource_group: str) -> dict[str, Any]:
    path = group_path(subscription_id, resource_group)
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    group = client.get(path, api=deploy.RESOURCE_API)
    if group is None:
        raise RequestError("资源组不存在，请刷新列表")
    actual_name = str(group.get("name") or "")
    if actual_name.casefold() != resource_group.casefold():
        raise RequestError("Azure 返回的资源组与目标不一致")
    resources = group_resources(client, path)
    token = uuid.uuid4().hex
    with _DELETE_LOCK:
        if (subscription_id, actual_name.casefold()) in _DELETE_PENDING:
            raise RequestError("该资源组已提交删除，请在 Azure 门户确认状态")
        now = time.monotonic()
        for key, value in list(_DELETE_PREVIEWS.items()):
            if value["expires"] < now:
                del _DELETE_PREVIEWS[key]
        _DELETE_PREVIEWS[token] = {"subscription_id": subscription_id, "resource_group": actual_name,
                                   "client_id": credentials["AZURE_CLIENT_ID"],
                                   "tenant_id": credentials["AZURE_TENANT_ID"],
                                   "ids": [item["id"] for item in resources], "expires": now + 120}
    return {"subscription_id": subscription_id, "resource_group": actual_name, "resource_count": len(resources),
            "resources": [{"name": item["name"], "type": item["type"]} for item in resources[:30]],
            "truncated": len(resources) > 30, "confirmation_token": token}


def delete_group(credentials: dict[str, str], subscription_id: str, resource_group: str,
                 confirmation: Any, token: Any) -> dict[str, Any]:
    if clean_text(confirmation, "确认名称", required=True, limit=128) != resource_group:
        raise RequestError("请手动输入与预览一致的完整资源组名称（区分大小写）")
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
        raise RequestError("请重新预览资源组后再确认删除")
    key = (subscription_id, resource_group.casefold())
    with _DELETE_LOCK:
        preview = _DELETE_PREVIEWS.pop(token, None)  # 一次性使用，失败也必须重新预览。
        if (not preview or preview["expires"] < time.monotonic() or preview["subscription_id"] != subscription_id
                or preview["resource_group"] != resource_group or preview["client_id"] != credentials["AZURE_CLIENT_ID"]
                or preview["tenant_id"] != credentials["AZURE_TENANT_ID"]):
            raise RequestError("删除确认已失效，请重新预览资源组")
        if key in _DELETE_PENDING or MANAGER.status()["status"] == "running":
            raise RequestError("已有资源组删除或模型部署任务运行中，请稍后重试")
        _DELETE_PENDING.add(key)
    delete_started = False
    try:
        path = group_path(subscription_id, resource_group)
        client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
        group = client.get(path, api=deploy.RESOURCE_API)
        if group is None or group.get("name") != resource_group:
            raise RequestError("资源组已不存在或名称发生变化，请重新读取")
        if [item["id"] for item in group_resources(client, path)] != preview["ids"]:
            raise RequestError("资源组内资源已变化，请重新预览后再删除")
        delete_started = True  # 请求一旦发出，网络失败时也可能已经被 Azure 接受。
        _, _, status = client.request("DELETE", path, api=deploy.RESOURCE_API)
        # ARM 可能返回 202：仅表示接受了异步请求，并非删除完成。
        return {"subscription_id": subscription_id, "resource_group": resource_group, "status": status,
                "message": "Azure 已接受删除请求，请稍后刷新确认" if status == 202 else "Azure 已返回删除请求结果，请刷新确认"}
    except Exception:
        if not delete_started:
            with _DELETE_LOCK:
                _DELETE_PENDING.discard(key)
        raise


def lookup_region_models(credentials: dict[str, str], subscription_id: str, location: str) -> dict[str, Any]:
    """无需现有资源组/账号，按目标订阅和区域读取 ARM 模型目录。"""
    location = deploy.normalize_location(clean_text(location, "部署区域", required=True, limit=40))
    if not re.fullmatch(r"[a-z][a-z0-9]{1,39}", location) or location.startswith(("china", "usgov", "usdod")):
        raise RequestError("请选择有效的 Azure 公有云区域")
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    catalog = client.list(f"/subscriptions/{subscription_id}/providers/Microsoft.CognitiveServices/locations/{location}/models", api="2024-10-01")
    models_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for entry in catalog[:10000]:
        if not isinstance(entry, dict):
            continue
        # API 响应可能把模型字段放入 model 子对象，兼容两种形状。
        model = entry.get("model") if isinstance(entry.get("model"), dict) else entry
        name = str(model.get("name") or "").strip()
        fmt = str(model.get("format") or "").strip()
        version = str(model.get("version") or "").strip()
        if not name or not fmt or not version or str(model.get("lifecycleStatus") or "").casefold() == "deprecated":
            continue
        skus = []
        # Region catalog may return one skuName per item; account catalog uses skus[].
        raw_skus = entry.get("skus") or model.get("skus") or []
        if not raw_skus and entry.get("skuName"):
            raw_skus = [{"name": entry["skuName"]}]
        for sku in raw_skus:
            if not isinstance(sku, dict) or not sku.get("name"):
                continue
            sku_name = str(sku["name"])
            if sku_name not in deploy.SUPPORTED_SKUS:
                continue  # 当前部署器只实现按量 SKU。
            capacity = sku.get("capacity") if isinstance(sku.get("capacity"), dict) else {}
            skus.append({"name": sku_name, "minimum": capacity.get("minimum"), "maximum": capacity.get("maximum"), "step": capacity.get("step")})
        if skus:
            key = (name, fmt, version)
            result = models_by_key.setdefault(key, {"name": name, "format": fmt, "version": version,
                                                     "is_default": False, "skus": []})
            result["is_default"] |= model.get("isDefaultVersion") is True
            for sku in skus:
                if not any(existing["name"] == sku["name"] for existing in result["skus"]):
                    result["skus"].append(sku)
    models = list(models_by_key.values())
    models.sort(key=lambda item: (item["name"].casefold(), not item["is_default"], item["version"].casefold()))
    return {"subscription_id": subscription_id, "location": location, "models": models}


def lookup_account_models(credentials: dict[str, str], subscription_id: str, resource_group: str, account_name: str) -> dict[str, Any]:
    """从指定现有 Foundry/Cognitive Services 资源读取实际可部署模型、版本与 SKU。"""
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    account_path = f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}/providers/Microsoft.CognitiveServices/accounts/{account_name}"
    account = client.get(account_path)
    if account is None:
        raise RequestError("未找到指定的 Foundry 资源；请先重新查询订阅信息")
    properties = account.get("properties") or {}
    if (account.get("kind") != "AIServices" or properties.get("allowProjectManagement") is not True
            or str(properties.get("provisioningState") or "Succeeded").casefold() != "succeeded"):
        raise RequestError("该账号不是可追加模型的 Foundry 资源，或仍在创建中")
    catalog = client.list(account_path + "/models")
    models: list[dict[str, Any]] = []
    for item in catalog[:5000]:
        if not isinstance(item, dict):
            continue
        name, model_format, version = (str(item.get("name") or "").strip(), str(item.get("format") or "").strip(), str(item.get("version") or "").strip())
        if not name or not model_format or not version or str(item.get("lifecycleStatus") or "").casefold() == "deprecated":
            continue
        skus = []
        for sku in item.get("skus") or []:
            if not isinstance(sku, dict) or sku.get("name") not in deploy.SUPPORTED_SKUS:
                continue  # 只列出部署器支持的按量 SKU。
            capacity = sku.get("capacity") if isinstance(sku.get("capacity"), dict) else {}
            skus.append({
                "name": str(sku.get("name")),
                "minimum": capacity.get("minimum", 1),
                "maximum": capacity.get("maximum"),
                "step": capacity.get("step"),
            })
        if skus:
            models.append({"name": name, "format": model_format, "version": version, "is_default": item.get("isDefaultVersion") is True, "skus": skus})
    models.sort(key=lambda item: (item["name"].casefold(), item["format"].casefold(), not item["is_default"], item["version"].casefold()))
    return {
        "account": {"name": account_name, "resource_group": resource_group, "location": str(account.get("location") or "")},
        "models": models,
    }


def lookup_projects(credentials: dict[str, str], subscription_id: str, resource_group: str, account_name: str) -> dict:
    """只读已有 Foundry 的 Project；不因读取失败伪造空列表。"""
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    path = group_path(subscription_id, resource_group) + "/providers/Microsoft.CognitiveServices/accounts/" + account_name
    account = client.get(path)
    if account is None:
        raise RequestError("所选 Foundry 已不存在，请刷新资源列表")
    if account.get("kind") != "AIServices" or (account.get("properties") or {}).get("allowProjectManagement") is not True:
        raise RequestError("所选账号不支持 Foundry Project，请新建 Foundry 或选择兼容账号")
    projects = client.list(path + "/projects")
    return {"projects": [{"name": str(p.get("name") or "").rsplit("/", 1)[-1],
                           "location": str(p.get("location") or ""),
                           "display_name": str((p.get("properties") or {}).get("displayName") or "")}
                          for p in projects if isinstance(p, dict) and p.get("name")]}


def inspect_targets(credentials: dict[str, str], targets: list[dict]) -> list[dict]:
    """只读精确资源路径，列表可见与否不代替 GET 的真实错误。

    新建名称若已存在，只允许兼容复用，不 PUT 覆盖；返回真实动作供确认页展示。
    existing 的 404 必须报错，不能静默切换到 new。
    """
    token = deploy.TokenProvider("service-principal", credentials=credentials)
    clients, cache, result = {}, {}, []
    def get(client, path, api=deploy.COGNITIVE_API):
        key = (path.casefold(), api)
        if key not in cache:
            cache[key] = client.get(path, api=api)
        return cache[key]
    for target in targets:
        sub, label = target["subscription_id"], target["label"]
        if sub not in clients:
            clients[sub] = deploy.ArmClient(token, sub, timeout=90)
        client = clients[sub]
        group_id = group_path(sub, target["resource_group"])
        account_id = group_id + "/providers/Microsoft.CognitiveServices/accounts/" + target["account_name"]
        try:
            group = get(client, group_id, deploy.RESOURCE_API)
            if group is None and target["group_mode"] == "existing":
                raise RequestError(f"{label}：所选资源组已不存在，请重新选择")
            account = get(client, account_id) if group is not None else None
            if account is None and target["account_mode"] == "existing":
                raise RequestError(f"{label}：所选 Foundry 已不存在，请重新选择")
            if account is not None:
                props = account.get("properties") or {}
                if account.get("kind") != "AIServices" or props.get("allowProjectManagement") is not True:
                    raise RequestError(f"{label}：同名账号不是支持 Project 的 Foundry；请修改名称，不会覆盖旧账号")
                if deploy.normalize_location(account.get("location", "")) != target["location"]:
                    raise RequestError(f"{label}：Foundry 区域与部署区域不一致")
                if str(props.get("provisioningState") or "Succeeded").casefold() != "succeeded":
                    raise RequestError(f"{label}：Foundry 尚未就绪，请稍后重试")
            project = get(client, account_id + "/projects/" + target["project_name"]) if account is not None else None
            if project is None and target["project_mode"] == "existing":
                raise RequestError(f"{label}：所选 Project 已不存在，请重新选择")
            if project is not None and deploy.normalize_location(project.get("location", "")) != target["location"]:
                raise RequestError(f"{label}：Project 区域与部署区域不一致")
        except deploy.DeployError as exc:
            raise RequestError(f"{label}：读取目标失败（不代表资源不存在）：" + deploy.redact(str(exc))) from None
        result.append({"target_id": target["id"], "label": label,
                       "resource_group": target["resource_group"], "account_name": target["account_name"],
                       "project_name": target["project_name"], "group_action": "reuse" if group is not None else "create",
                       "account_action": "reuse" if account is not None else "create",
                       "project_action": "reuse" if project is not None else "create"})
    return result

def lookup_content_filters(credentials: dict[str, str], subscription_id: str, resource_group: str, account_name: str) -> dict[str, Any]:
    """只读取该账号已有的 RAI 策略；不创建、不禁用任何安全审核。"""
    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
    account_path = f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}/providers/Microsoft.CognitiveServices/accounts/{account_name}"
    if client.get(account_path) is None:
        raise RequestError("未找到指定 Foundry 资源")
    policies = client.list(account_path + "/raiPolicies")
    filters = [{"name": str(item.get("name") or ""), "mode": str((item.get("properties") or {}).get("mode") or "")}
               for item in policies if isinstance(item, dict) and item.get("name")]
    filters.sort(key=lambda item: item["name"].casefold())
    return {"account": {"subscription_id": subscription_id, "resource_group": resource_group, "name": account_name}, "filters": filters}


def write_temp_plan(path: Path, plan: list[dict], credentials: dict, options: dict) -> None:
    """一次性 JSON 直接交给真实脚本；网页无需安装 Excel 读取依赖。"""
    path.write_text(json.dumps({"credentials": credentials, "run": options,
                                "deployments": plan}, ensure_ascii=False), encoding="utf-8")


def redact_for_page(message: str, secret: str = "") -> str:
    """再次过滤子进程日志，确保 Client Secret 绝不会返回浏览器。"""
    result = deploy.redact(message)
    if secret:
        result = result.replace(secret, "[REDACTED]")
    result = re.sub(r"(?i)(client_secret|access_token|refresh_token)([\s\"':=]+)[^\s,\"'}]+", r"\1\2[REDACTED]", result)
    return result[:4000]


class DeploymentManager:
    """单批运行；按明确的报告文件和任务 ID 对齐结果，不猜测成功数量。"""
    SUCCESS = {"created", "updated", "unchanged"}
    FAILURE = {"failed", "auth_failed", "config_failed", "not_run", "interrupted"}

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active_id = None
        self._latest = None

    def _snapshot(self, job):
        if not job:
            return {"status": "idle", "message": "尚未开始部署"}
        entries = job["entries"]
        counts = {"success": sum(e["status"] in self.SUCCESS for e in entries),
                  "failed": sum(e["status"] in self.FAILURE for e in entries),
                  "running": sum(e["status"] == "running" for e in entries),
                  "pending": sum(e["status"] == "pending" for e in entries)}
        result = {k: job.get(k) for k in ("id", "request_id", "status", "message", "started_at", "finished_at", "exit_code", "total", "logs", "files", "entries", "report")}
        result.update(counts=counts, completed=counts["success"] + counts["failed"])
        return json.loads(json.dumps(result, ensure_ascii=False))

    @staticmethod
    def _row_key(row, chinese=False):
        keys = ("订阅ID", "资源组", "Foundry资源名称", "部署名称") if chinese else ("subscription_id", "resource_group", "account_name", "deployment_name")
        return tuple(str(row.get(key, "")).casefold() for key in keys)

    def _refresh(self, job):
        """读取原子替换的本批报告；其它进程生成的文件不属于这个批次。"""
        path = OUTPUT_DIR / (job["stem"] + ".json")
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(report, dict) or not isinstance(report.get("deployments"), list):
                return
        except (OSError, ValueError):
            return
        job["report"] = report
        rows = {self._row_key(row, True): row for row in report["deployments"] if isinstance(row, dict)}
        for entry in job["entries"]:
            row = rows.get(self._row_key(entry["row"]))
            if row:
                status = row.get("状态", "pending")
                # 报告写入以最终结果为主，不让旧 pending 覆盖实时阶段。
                if status not in {"pending", "starting", "running"}:
                    entry.update(status=status, error=row.get("错误", ""),
                                 stage="完成" if status in self.SUCCESS else "失败")
                entry["result"] = row
        job["files"] = [{"name": job["stem"] + suffix, "url": "/api/download/" + job["stem"] + suffix}
                        for suffix in (".json", ".csv", ".xlsx") if (OUTPUT_DIR / (job["stem"] + suffix)).is_file()]

    def _finalize_report(self, job):
        """补齐未执行/中断项，确保下载报告与页面逐行状态一致。"""
        from collections import Counter
        from foundry_results import ReportExporter, RESULT_FIELDS
        records = []
        for entry in job["entries"]:
            record = dict(entry["row"])
            result = entry.get("result") or {}
            for label, key, _ in RESULT_FIELDS:
                if label in result:
                    record[key] = result[label]
            record.update(status=entry["status"], error=entry.get("error", ""))
            records.append(record)
        original = job.get("report") or {}
        report = {key: value for key, value in original.items()
                  if key not in {"deployments", "columns", "summary", "contains_resource_api_keys"}}
        report.update(mode="apply", deployments=records,
                      summary=dict(Counter(row["status"] for row in records)),
                      finished_at=job["finished_at"])
        exporter = ReportExporter(OUTPUT_DIR, stem=job["stem"],
                                  started_at=datetime.fromisoformat(job["started_at"]))
        exporter.write(report)
        self._refresh(job)

    def status(self):
        with self._lock:
            if self._latest and self._latest["status"] == "running":
                self._refresh(self._latest)
            return self._snapshot(self._latest)

    def start(self, credentials, plan, options, *, task_ids, request_id=""):
        with self._lock:
            if self._active_id:
                raise RequestError("已有部署正在运行，请等待完成")
            now = datetime.now().astimezone()
            job_id = uuid.uuid4().hex[:12]
            job = {"id": job_id, "request_id": request_id, "status": "running",
                   "message": "正在准备真实 Azure 部署", "started_at": now.isoformat(timespec="seconds"),
                   "stem": "results_" + now.strftime("%Y-%m-%d_%H%M%S_%f") + "_" + job_id,
                   "total": len(plan), "logs": ["已接收计划；登录凭据不会导出。"], "files": [], "report": None,
                   "entries": [{"id": task_id, "row": row, "status": "pending", "stage": "排队", "error": ""}
                               for task_id, row in zip(task_ids, plan)]}
            self._active_id = job_id
            self._latest = job
        threading.Thread(target=self._run, args=(job, credentials, plan, options), daemon=True).start()
        with self._lock:
            return self._snapshot(job)

    def _append_log(self, job, line, secret):
        line = redact_for_page(line.strip(), secret)
        if not line:
            return
        with self._lock:
            if line.startswith("__FOUNDRY_PROGRESS__"):
                try:
                    event = json.loads(line[len("__FOUNDRY_PROGRESS__"):])
                    index = event["index"]
                    if isinstance(index, int) and 0 <= index < len(job["entries"]):
                        entry = job["entries"][index]
                        entry.update(status="running", stage=str(event["stage"])[:100])
                    return
                except (ValueError, KeyError, TypeError):
                    pass
            job["logs"].append(line)
            del job["logs"][:-160]

    def _run(self, job, credentials, plan, options):
        secret = credentials["AZURE_CLIENT_SECRET"]
        try:
            if not RUNNER_FILE.is_file() or not PAGE_FILE.is_file():
                raise RuntimeError("部署系统文件不完整")
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="foundry-web-") as temp_dir:
                workspace = Path(temp_dir)
                config_file = workspace / "deployment-plan.json"
                write_temp_plan(config_file, plan, credentials, options)
                command = [sys.executable, "-u", str(RUNNER_FILE), "--config", str(config_file),
                           "--plan-json", "--output-dir", str(OUTPUT_DIR),
                           "--report-stem", job["stem"], "--apply", "--no-api-key"]
                environment = dict(__import__("os").environ)
                environment["PYTHONIOENCODING"] = "utf-8"
                with subprocess.Popen(command, cwd=str(BASE_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, encoding="utf-8", errors="replace", env=environment) as process:
                    assert process.stdout is not None
                    for line in process.stdout:
                        self._append_log(job, line, secret)
                    exit_code = process.wait()
            with self._lock:
                self._refresh(job)
                for entry in job["entries"]:
                    if entry["status"] in {"pending", "running"}:
                        uncertain = entry["status"] == "running"
                        entry.update(status="interrupted" if uncertain else "not_run",
                                     stage="状态待核实" if uncertain else "未执行",
                                     error="没有收到最终结果；请核实 Azure 状态后重试" if uncertain else "进程结束前未执行，请查看日志")
                ok = all(e["status"] in self.SUCCESS for e in job["entries"])
                job.update(exit_code=exit_code, status="succeeded" if ok and exit_code == 0 else "completed_with_errors",
                           message="部署完成" if ok and exit_code == 0 else "部署结束，存在失败或未确认项")
        except Exception as exc:
            with self._lock:
                self._refresh(job)
                message = "部署系统错误：" + redact_for_page(str(exc), secret)
                for entry in job["entries"]:
                    if entry["status"] in {"pending", "running"}:
                        entry.update(status="interrupted" if entry["status"] == "running" else "not_run", stage="未完成", error=message)
                job.update(status="failed", message=message, exit_code=2)
        finally:
            credentials.clear()
            with self._lock:
                job["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
                try:
                    self._finalize_report(job)
                except Exception as exc:
                    # 磁盘/文件占用问题不覆盖真实部署结果，明确告知用户导出失败。
                    message = "结果导出未完成：" + redact_for_page(str(exc), secret)
                    job["logs"].append(message)
                    job["message"] += "；结果导出未完成，请查看日志"
                self._active_id = None


MANAGER = DeploymentManager()
_SUBMIT_LOCK = threading.Lock()
_SUBMISSION_STATE_LOCK = threading.Lock()
_SUBMISSION_STATES: dict[str, dict] = {}


def submission_state(request_id: str, state: dict | None = None) -> dict:
    """轻量请求回执，让浏览器超时后区分预检中、明确拒绝和已接收。"""
    with _SUBMISSION_STATE_LOCK:
        if state is not None:
            _SUBMISSION_STATES[request_id] = state
            # 仅保留最近回执，不记录凭据或计划正文。
            if len(_SUBMISSION_STATES) > 200:
                oldest = next(iter(_SUBMISSION_STATES))
                if _SUBMISSION_STATES[oldest].get("status") != "checking":
                    del _SUBMISSION_STATES[oldest]
        return dict(_SUBMISSION_STATES.get(request_id, {"status": "unknown"}))



class FoundryHandler(BaseHTTPRequestHandler):
    """仅支持本机页面、SP 验证、真实部署状态及结果下载。"""

    server_version = "FoundryLocal/1.0"

    def log_message(self, _format: str, *args: Any) -> None:
        # 不将 HTTP 请求内容写入控制台，避免误记录包含 SP 的请求细节。
        return

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError("请求长度无效") from None
        if length <= 0 or length > MAX_BODY_BYTES:
            raise RequestError("请求数据为空或过大")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RequestError("页面提交的数据格式错误") from None
        if not isinstance(body, dict):
            raise RequestError("页面提交的数据格式错误")
        return body

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            try:
                data = PAGE_FILE.read_bytes()
            except OSError:
                self.send_error(HTTPStatus.NOT_FOUND, "控制台页面文件不存在")
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/api/submission-status/"):
            request_id = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_json(submission_state(request_id))
            return
        if path == "/api/version":
            self.send_json({"version": console_plan.VERSION})
            return
        # 只开放正式控制台静态文件；绝不暴露配置、源码和目录列表。
        assets = {"/foundry_console.js": "text/javascript", "/foundry_plan.js": "text/javascript",
                  "/foundry_console.css": "text/css"}
        if path in assets:
            data = (BASE_DIR / path.lstrip("/")).read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", assets[path] + "; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/status":
            self.send_json(MANAGER.status())
            return
        if path.startswith("/api/download/"):
            self.download(path.rsplit("/", 1)[-1])
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def download(self, filename: str) -> None:
        if not DOWNLOAD_RE.fullmatch(filename):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        target = (OUTPUT_DIR / filename).resolve()
        if target.parent != OUTPUT_DIR.resolve() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = {".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}[target.suffix]
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            # 浏览器跨站请求不能驱动本机控制台；CLI 无 Origin 时仍可使用。
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                raise RequestError("请从本机控制台地址操作，不接受跨站请求")
            body = self.read_json()
            if path == "/api/preview-plan":
                plan, targets, task_ids = console_plan.build_plan(body.get("targets"), body.get("tasks"))
                self.send_json({"ok": True, "deployments": plan, "targets": targets, "task_ids": task_ids})
                return
            if path == "/api/check-plan":
                plan, targets, task_ids = console_plan.build_plan(body.get("targets"), body.get("tasks"))
                credentials = validate_credentials(body.get("credentials"))
                try:
                    observations = inspect_targets(credentials, targets)
                finally:
                    credentials.clear()
                self.send_json({"ok": True, "deployments": plan, "targets": targets, "task_ids": task_ids, "observations": observations})
                return
            if path == "/api/lookup-projects":
                credentials = validate_credentials(body.get("credentials"))
                try:
                    details = lookup_projects(credentials, require_guid(body.get("subscription_id"), "订阅 ID"),
                        require_group_name(body.get("resource_group")), require_resource_segment(body.get("account_name"), "Foundry 名称"))
                except deploy.DeployError as exc:
                    raise RequestError("读取 Project 失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/validate-sp":
                credentials = validate_credentials(body.get("credentials"))
                try:
                    # 仅请求 Microsoft Entra token，不读取订阅、不创建任何 Azure 资源。
                    deploy.TokenProvider("service-principal", credentials=credentials).get("")
                except deploy.DeployError as exc:
                    self.send_json({"ok": False, "message": deploy.redact(str(exc))}, HTTPStatus.BAD_REQUEST)
                    return
                finally:
                    credentials.clear()
                self.send_json({"ok": True, "message": "SP 凭据已通过 Microsoft Entra 令牌验证；尚未创建或修改 Azure 资源。"})
                return
            if path == "/api/list-subscriptions":
                credentials = validate_credentials(body.get("credentials"))
                try:
                    subscriptions = list_accessible_subscriptions(credentials)
                except deploy.DeployError as exc:
                    raise RequestError("读取订阅失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, "subscriptions": subscriptions})
                return
            if path == "/api/lookup-subscription":
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                try:
                    details = lookup_subscription(credentials, subscription_id)
                except deploy.DeployError as exc:
                    raise RequestError("查询订阅失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/check-resource-group":
                # 提交前直接 GET 精确目标；仅检查存在性，不使用列表权限也不修改资源。
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                resource_group = require_group_name(body.get("resource_group"))
                try:
                    client = deploy.ArmClient(deploy.TokenProvider("service-principal", credentials=credentials), subscription_id, timeout=90)
                    group = client.get(group_path(subscription_id, resource_group), api=deploy.RESOURCE_API)
                except deploy.DeployError as exc:
                    raise RequestError("校验资源组失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, "exists": group is not None,
                                "resource_group": str(group.get("name") or resource_group) if group else resource_group})
                return
            if path == "/api/preview-delete-group" or path == "/api/delete-group":
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                resource_group = require_group_name(body.get("resource_group"))
                try:
                    if path == "/api/preview-delete-group":
                        details = preview_delete_group(credentials, subscription_id, resource_group)
                    else:
                        details = delete_group(credentials, subscription_id, resource_group,
                                               body.get("confirmation"), body.get("confirmation_token"))
                except deploy.DeployError as exc:
                    raise RequestError("资源组操作失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/lookup-region-models":
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                try:
                    details = lookup_region_models(credentials, subscription_id, body.get("location"))
                except deploy.DeployError as exc:
                    raise RequestError("读取区域模型失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/lookup-models":
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                resource_group = require_group_name(body.get("resource_group"))
                account_name = require_resource_segment(body.get("account_name"), "Foundry 资源名")
                try:
                    details = lookup_account_models(credentials, subscription_id, resource_group, account_name)
                except deploy.DeployError as exc:
                    raise RequestError("查询模型失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/lookup-content-filters":
                credentials = validate_credentials(body.get("credentials"))
                subscription_id = require_guid(body.get("subscription_id"), "Azure 订阅 ID")
                resource_group = require_group_name(body.get("resource_group"))
                account_name = require_resource_segment(body.get("account_name"), "Foundry 资源名")
                try:
                    details = lookup_content_filters(credentials, subscription_id, resource_group, account_name)
                except deploy.DeployError as exc:
                    raise RequestError("读取内容筛选器失败：" + deploy.redact(str(exc))) from None
                finally:
                    credentials.clear()
                self.send_json({"ok": True, **details})
                return
            if path == "/api/deploy":
                # v2 只接受目标 + 任务，不信任浏览器自行展开的行，也不做区域×模型笛卡尔积。
                plan, targets, task_ids = console_plan.build_plan(body.get("targets"), body.get("tasks"))
                options = validate_options(body.get("options"))
                credentials = validate_credentials(body.get("credentials"))
                request_id = clean_text(body.get("request_id"), "请求标识", required=True, limit=80)
                if not re.fullmatch(r"[A-Za-z0-9_-]+", request_id):
                    raise RequestError("请求标识无效")
                handed_off = False
                checking = False
                try:
                    with _SUBMIT_LOCK, _DELETE_LOCK:
                        current = MANAGER.status()
                        if current.get("request_id") == request_id:
                            self.send_json(current, HTTPStatus.ACCEPTED)
                            return
                        if submission_state(request_id).get("status") == "accepted":
                            raise RequestError("此请求已提交过，不会重复创建；请刷新查看任务状态")
                        if MANAGER.status().get("status") == "running":
                            raise RequestError("已有部署正在运行，请等待完成")
                        if any((row["subscription_id"], row["resource_group"].casefold()) in _DELETE_PENDING for row in plan):
                            raise RequestError("所选资源组正在删除，不能提交部署")
                        submission_state(request_id, {"status": "checking"})
                        checking = True
                        inspect_targets(credentials, targets)
                        # 仅传递核心计划字段；来源约束随 JSON 传入真实部署脚本。
                        rows = [{key: str(row.get(key, "")) for key, _ in PLAN_COLUMNS} for row in plan]
                        job = MANAGER.start(credentials, rows, options, task_ids=task_ids, request_id=request_id)
                        handed_off = True
                        submission_state(request_id, {"status": "accepted", "job_id": job["id"]})
                except Exception as exc:
                    if checking and not handed_off:
                        submission_state(request_id, {"status": "rejected", "message": redact_for_page(str(exc), credentials.get("AZURE_CLIENT_SECRET", ""))})
                    raise
                finally:
                    if not handed_off:
                        credentials.clear()
                self.send_json(job, HTTPStatus.ACCEPTED)
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (RequestError, deploy.PlanError) as exc:
            self.send_json({"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self.send_json({"ok": False, "message": "请求处理失败，请检查页面填写内容后重试。"}, HTTPStatus.INTERNAL_SERVER_ERROR)


class SingleInstanceHTTPServer(ThreadingHTTPServer):
    """禁止端口复用；Windows 上排他绑定，避免多个旧/新控制台抢同一个端口。"""
    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> int:
    if not PAGE_FILE.is_file() or not RUNNER_FILE.is_file():
        print("启动失败：缺少网页或真实部署脚本。", file=sys.stderr)
        return 2
    try:
        server = SingleInstanceHTTPServer((HOST, PORT), FoundryHandler)
    except OSError:
        print(f"启动失败：本机端口 {PORT} 已被占用。请只保留一个控制台窗口，然后打开 http://{HOST}:{PORT}/", file=sys.stderr)
        return 2
    print(f"Foundry 本机部署控制台已启动：http://{HOST}:{PORT}", flush=True)
    print("仅监听本机；关闭此窗口会停止网页服务。", flush=True)
    browser_timer = threading.Timer(0.4, lambda: webbrowser.open(f"http://{HOST}:{PORT}/"))
    browser_timer.daemon = True
    browser_timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("服务已停止。", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())




