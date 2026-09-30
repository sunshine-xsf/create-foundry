"""部署成功后的只读补充信息，不改变资源、授权或内容过滤策略。

接口按 Azure/azure-rest-api-specs 中 CognitiveServices stable/2025-06-01
和 Microsoft.Resources/subscriptions stable/2022-12-01 核对。
详情读取失败仅产生报告警告，不把已经成功的部署标为失败。
"""
from __future__ import annotations

import math
from urllib.parse import quote

from deploy_foundry import DeployError, COGNITIVE_API, remember_secret

SUBSCRIPTION_API = "2022-12-01"


def actual_endpoint(endpoints: dict, *, openai=False):
    """返回服务给出的地址，不通过资源名猜造 URL。"""
    if not isinstance(endpoints, dict):
        return ""
    values = {str(key): value for key, value in endpoints.items() if isinstance(value, str) and value}
    if not values:
        return ""
    if openai:
        language = {value for key, value in values.items() if "openai" in key.casefold() and "language model" in key.casefold()}
        if len(language) == 1:
            return next(iter(language))
        selected = {value for key, value in values.items() if "openai" in key.casefold()}
        return next(iter(selected)) if len(selected) == 1 else ""
    preferred = {value for key, value in values.items()
                 if any(word in key.casefold() for word in ("aifoundry", "ai foundry", "ai services", "aiservices"))}
    if len(preferred) == 1:
        return next(iter(preferred))
    unique = set(values.values())
    return next(iter(unique)) if len(unique) == 1 else values


def actual_tpm(properties: dict):
    """仅取明确的 60 秒 tokens 规则；其它窗口/多个不同限制留空，避免误导。"""
    values = set()
    for rule in properties.get("rateLimits") or []:
        if not isinstance(rule, dict) or str(rule.get("key", "")).casefold() not in {"token", "tokens"}:
            continue
        count, period = rule.get("count"), rule.get("renewalPeriod")
        if type(count) in (int, float) and math.isfinite(count) and count >= 0 and period == 60:
            values.add(count)
    if len(values) != 1:
        return ""
    value = next(iter(values))
    return int(value) if value == int(value) else value


class DeploymentDetails:
    def __init__(self, client, exporter):
        self.client = client
        self.exporter = exporter
        self.cache: dict[tuple, tuple[dict, str]] = {}

    def read(self, path: str, label: str, warnings: list, *, api=COGNITIVE_API, keys=False):
        cache_key = (path.casefold(), api, keys)
        if cache_key not in self.cache:
            try:
                response = (self.client.request("POST", path, api=api)[0] if keys else self.client.get(path, api))
                if not isinstance(response, dict):
                    raise DeployError("资源未返回有效对象")
                self.cache[cache_key] = (response, "")
            except (DeployError, OSError, ValueError, TypeError, KeyError) as exc:
                # 不回显服务端整个对象，更不在日志中打印 listKeys 的结果。
                code = getattr(exc, "status", None)
                reason = f"HTTP {code}" if isinstance(code, int) else type(exc).__name__
                self.cache[cache_key] = ({}, f"{label}读取失败（{reason}），相关列可能为空；部署结果不受影响。")
        value, warning = self.cache[cache_key]
        if warning:
            warnings.append(warning)
        return value

    def enrich(self, item, row: dict) -> None:
        if row.get("status") not in {"created", "updated", "unchanged"}:
            return
        warnings = row.setdefault("report_warnings", [])
        sub = self.read(f"/subscriptions/{item.subscription_id}", "订阅名称", warnings, api=SUBSCRIPTION_API)
        row["subscription_name"] = sub.get("displayName", "")
        account = self.read(item.account_id, "账号详情", warnings)
        project = self.read(item.project_id, "项目详情", warnings)
        deployment = self.read(item.deployment_id, "部署详情", warnings)
        props = account.get("properties") or {}
        project_props = project.get("properties") or {}
        deployment_props = deployment.get("properties") or {}
        row["account_endpoint"] = props.get("endpoint") or row.get("account_endpoint", "")
        row["project_endpoints"] = project_props.get("endpoints") or row.get("project_endpoints", {})
        row["endpoint"] = actual_endpoint(row["project_endpoints"])
        row["azure_openai_endpoint"] = (actual_endpoint(props.get("endpoints", {}), openai=True)
                                          or actual_endpoint(row["project_endpoints"], openai=True))
        row["project_resource_id"] = project.get("id") or row.get("project_resource_id", item.project_id)
        row["tpm"] = actual_tpm(deployment_props)
        if row["tpm"] == "":
            warnings.append("TPM 未获得明确的每分钟 tokens 限制；留空，不以 capacity × 1000 推算。")
        if not row["endpoint"]:
            warnings.append("Azure 未返回项目 Endpoint，未通过域名拼接生成。")
        if not row["azure_openai_endpoint"]:
            warnings.append("Azure 未返回可唯一确定的 Azure OpenAI 端点。")
        model = deployment_props.get("model") or {}
        row["resolved_model_version"] = model.get("version") or row.get("resolved_model_version", "")
        policy = deployment_props.get("raiPolicyName")
        row["rai_policy"] = policy if isinstance(policy, str) else ""
        row["streaming_filter_mode"] = ""
        if row["rai_policy"] and policy not in {".", ".."}:
            policy_object = self.read(item.account_id + "/raiPolicies/" + quote(policy, safe=""), "RAI 策略", warnings)
            row["streaming_filter_mode"] = (policy_object.get("properties") or {}).get("mode", "")
        if not row["streaming_filter_mode"]:
            warnings.append("Azure 未返回可读取的 RAI 策略/流式过滤模式；未更改内容过滤设置。")
        # listKeys 只在成功部署、用户开启导出且没有禁用本地认证时调用。
        if self.exporter.include_api_keys:
            if not account:
                warnings.append("无法核实账号认证设置，本次不读取资源密钥。")
            elif props.get("disableLocalAuth") is True:
                warnings.append("账号已禁用本地密钥认证，密钥列留空；不会自动启用。")
            else:
                keys = self.read(item.account_id + "/listKeys", "资源密钥", warnings, keys=True)
                key = keys.get("key1") or keys.get("key2")
                if not self.exporter.remember_api_key(item.deployment_id, key):
                    warnings.append("未获得可导出的资源 API key，密钥列留空。")
                for value in (keys.get("key1"), keys.get("key2")):
                    remember_secret(value)
        row["report_warnings"] = list(dict.fromkeys(warnings))
