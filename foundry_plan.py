"""控制台部署计划：目标只配置一次，模型任务只引用一个目标。

这里只做离线规范化；不会登录 Azure。预览和真实提交必须调用同一函数，
避免前端名称、任务数量和部署脚本收到的内容不同。
"""
from __future__ import annotations
from dataclasses import asdict
from typing import Any
import re
import deploy_foundry as deploy

VERSION = "2026.10.10-customer-v3"
TARGET_FIELDS = {"id", "label", "subscription_id", "location", "group_mode", "resource_group",
                 "account_mode", "account_name", "project_mode", "project_name"}
TASK_FIELDS = {"id", "target_id", "model_name", "model_version", "model_format", "sku_name",
               "capacity", "deployment_name", "rai_policy_name"}


def string(value: Any, label: str, *, required: bool = True) -> str:
    if not isinstance(value, str) or len(value) > 1000:
        raise deploy.PlanError(f"{label} 必须是长度不超过 1000 的文本")
    value = value.strip()
    if required and not value:
        raise deploy.PlanError(f"请填写{label}")
    return value


def mode(value: Any, label: str) -> str:
    if value not in ("new", "existing"):
        raise deploy.PlanError(f"{label}请选择新建或使用已有")
    return value


def normalize_targets(raw: Any) -> dict[str, dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
        raise deploy.PlanError("请配置 1–20 个部署目标")
    targets = {}
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict) or set(item) - TARGET_FIELDS:
            raise deploy.PlanError(f"目标 {index} 包含无法识别的字段")
        target = {key: string(item.get(key, ""), f"目标 {index} {key}", required=False)
                  for key in TARGET_FIELDS}
        target_id = string(target["id"], f"目标 {index} ID")
        if target_id in targets or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", target_id):
            raise deploy.PlanError("部署目标 ID 重复或无效")
        for key in ("group_mode", "account_mode", "project_mode"):
            target[key] = mode(target[key], f"目标 {index} {key}：")
        for key in ("resource_group", "account_name", "project_name"):
            string(target[key], f"目标 {index} {key}")
        if target["account_mode"] == "existing":
            string(target["account_name"], f"目标 {index} 已有 Foundry 名称")
            if target["group_mode"] != "existing":
                raise deploy.PlanError(f"目标 {index}：使用已有 Foundry 时必须选择已有资源组")
        if target["project_mode"] == "existing" and target["account_mode"] != "existing":
            raise deploy.PlanError(f"目标 {index}：已有 Project 必须属于所选的已有 Foundry")
        normalized = asdict(deploy.normalize_item({**target, "model_name": "preview-model"}, index))
        for key in ("subscription_id", "location", "resource_group", "account_name", "project_name"):
            target[key] = normalized[key]
        target["label"] = target["label"] or f"部署目标 {index}"
        targets[target_id] = target
    return targets


def build_plan(raw_targets: Any, raw_tasks: Any) -> tuple[list[dict], list[dict], list[str]]:
    targets = normalize_targets(raw_targets)
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= 100:
        raise deploy.PlanError("请选择 1–100 条模型任务")
    plan, task_ids, seen_ids, seen_deployments, used = [], [], set(), set(), set()
    # 一个实际资源只能有一种来源；Project 不同也不能重复部署到同一 account/deployment。
    resource_modes = {}
    account_regions = {}
    for number, task in enumerate(raw_tasks, 1):
        if not isinstance(task, dict) or set(task) - TASK_FIELDS:
            raise deploy.PlanError(f"任务 {number} 包含无法识别的字段")
        task = {key: string(task.get(key, ""), f"任务 {number} {key}", required=False) for key in TASK_FIELDS}
        task_id = string(task["id"], f"任务 {number} ID")
        if task_id in seen_ids or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", task_id):
            raise deploy.PlanError("模型任务 ID 重复或无效")
        seen_ids.add(task_id)
        target = targets.get(task["target_id"])
        if not target:
            raise deploy.PlanError(f"任务 {number} 没有有效的部署目标")
        used.add(target["id"])
        string(task["deployment_name"], f"任务 {number} 模型部署名称")
        row = {**target, **{k: v for k, v in task.items() if k not in {"id", "target_id"}}}
        row.update(resource_group_mode=target["group_mode"], account_mode=target["account_mode"],
                   project_mode=target["project_mode"])
        normalized = asdict(deploy.normalize_item(row, number))
        key = (normalized["subscription_id"], normalized["resource_group"].casefold(),
               normalized["account_name"].casefold(), normalized["deployment_name"].casefold())
        if key in seen_deployments:
            raise deploy.PlanError(f"任务 {number} 与另一任务的模型部署名称重复，请修改名称或目标")
        seen_deployments.add(key)
        if key[:3] in account_regions and account_regions[key[:3]] != normalized["location"]:
            raise deploy.PlanError("同一个 Foundry 不能设置两个部署区域，请分开命名")
        account_regions[key[:3]] = normalized["location"]
        for resource, source in ((key[:2], target["group_mode"]), (key[:3], target["account_mode"]),
                                 (key[:3] + (target["project_name"].casefold(),), target["project_mode"])):
            if resource in resource_modes and resource_modes[resource] != source:
                raise deploy.PlanError("同一个资源在不同目标中同时被设为新建和使用已有，请统一来源")
            resource_modes[resource] = source
        plan.append(normalized)
        task_ids.append(task_id)
    # 未选模型的草稿目标不进行 Azure 查询，也不创建资源。
    return plan, [t for key, t in targets.items() if key in used], task_ids


def plan_fingerprint(plan, targets, task_ids, options):
    """无凭据的规范计划指纹；预览与执行必须使用相同名称、映射及选项。"""
    import hashlib
    import json
    value = {"version": VERSION, "deployments": plan, "targets": targets, "task_ids": task_ids, "options": options}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
