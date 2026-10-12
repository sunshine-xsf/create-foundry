/* Pure plan helpers. No network, storage or credentials persisted here. */
(function (scope) {
  'use strict';
  const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))).replaceAll('-', '').slice(-12);
  const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const joinName = (...parts) => parts.map(slug).filter(Boolean).join('-');
  // 资源组保留业务名大小写；Foundry / Project 使用 joinName 规范为小写。
  const groupNamePart = value => String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '');
  const joinGroupName = (...parts) => parts.map(groupNamePart).filter(Boolean).join('-');
  // 仅自动名称缩短；保留确定性后缀，重试和预览不会重新随机命名。
  function fitName(value, limit) {
    if (value.length <= limit) return value;
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return value.slice(0, limit - 9).replace(/[-_.]+$/, '') + '-' + hash.toString(16).padStart(8, '0');
  }
  function nameError(field, value) {
    if (!value) return '请填写名称';
    if (field === 'resource_group') return /^[\p{L}\p{N}_().-]{1,90}$/u.test(value) && !value.endsWith('.') ? '' : '1–90 字符：字母、数字、下划线、括号、点或短横线，不能以点结尾';
    if (field === 'account_name') return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value) ? '' : '2–64 字符：小写字母、数字、短横线，首尾为字母或数字';
    return (field !== 'project_name' || value.length >= 2) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? '' : 'Project 2–64 字符；模型部署名 1–64 字符，以字母或数字开头，可含 _ . -';
  }
  function newTarget(subscription = '') {
    return {id: uid('target'), label: '', subscription_id: subscription, location: 'eastus',
      group_mode: 'new', resource_group: '', account_mode: 'new', account_name: '',
      project_mode: 'new', project_name: '', drafts: {}, naming: {sequence: null, manual: {}, auto: {}}};
  }
  function accountName(target) {
    if (target.account_mode === 'existing') return target.account_name || '';
    return target.account_name || ''; // 所有名称必须在确认前确定，不使用隐藏的随机兜底。
  }
  function targetPayload(target, index = 0) {
    const out = {};
    for (const key of ['id', 'label', 'subscription_id', 'location', 'group_mode', 'resource_group', 'account_mode', 'account_name', 'project_mode', 'project_name']) out[key] = String(target[key] || '').trim();
    out.label ||= '目标 ' + (index + 1);
    out.account_name = accountName(target);
    return out;
  }
  function catalogKey(target) {
    return target.account_mode === 'existing'
      ? [target.subscription_id, 'account', target.resource_group, target.account_name].join('|').toLowerCase()
      : [target.subscription_id, 'region', target.location].join('|').toLowerCase();
  }
  const modelKey = model => model.format + '|' + model.name;
  function variants(model, target, catalogs) {
    const entry = catalogs[catalogKey(target)];
    return entry?.status === 'ready' ? entry.models.filter(m => modelKey(m) === modelKey(model)) : [];
  }
  function preferred(models) { return models.find(m => m.is_default) || models[0]; }
  function skuFor(model) { return model?.skus?.find(s => s.name === 'GlobalStandard') || model?.skus?.[0]; }
  function assignModel(model, targets, catalogs, tasks, sequence) {
    // 一次只处理一个明确勾选的目标，不按任务数分配，也不展开区域组合。
    if (targets.length !== 1) throw Error('请明确选择一个模型部署目标');
    const target = targets[0];
    const resolved = preferred(variants(model, target, catalogs).filter(m => m.skus?.length));
    const sku = skuFor(resolved);
    if (!resolved || !sku) throw Error('请先读取该目标的目录，并选择受支持的模型');
    return {id: uid('task'), target_id: target.id, model_name: model.name, model_format: model.format,
      model_version: resolved.version, sku_name: sku.name, capacity: String(sku.minimum || 1),
      deployment_name: '', rai_policy_name: model.format.toLowerCase() === 'openai' ? 'foundry-console-guard-low-v1' : '', sequence};
  }
  function deploymentName(task, target) {
    // 默认使用模型原名；仅用户明确填写时采用自定义名称。
    return task.deployment_name || task.model_name;
  }
  function taskPayload(task, targets) {
    const target = targets.find(t => t.id === task.target_id);
    if (!target) throw Error('模型缺少部署目标');
    const out = {};
    for (const key of ['id', 'target_id', 'model_name', 'model_version', 'model_format', 'sku_name', 'capacity', 'rai_policy_name']) out[key] = String(task[key] ?? '');
    out.deployment_name = deploymentName(task, target);
    return out;
  }
  function validateTargets(targets) {
    const errors = [];
    if (!targets.length) return ['请添加部署目标'];
    targets.forEach((t, i) => {
      const label = '目标 ' + (i + 1) + '：';
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(t.subscription_id)) errors.push(label + '请选择有效订阅');
      if (!t.location.trim()) errors.push(label + '请选择部署区域');
      for (const [field, mode, title] of [['resource_group','group_mode','资源组'],['account_name','account_mode','Foundry'],['project_name','project_mode','Project']]) {
        const value = (t[field] || '').trim();
        const error = value ? nameError(field, value) : (t[mode] === 'existing' ? '请选择已有资源' : '请设置名称');
        if (error) errors.push(label + title + '：' + error);
      }
    });
    return errors;
  }
  function validateTasks(targets, tasks, catalogs) {
    const errors = [];
    if (!tasks.length) return ['至少选择一个模型'];
    const names = new Set();
    tasks.forEach((task, i) => {
      const label = '任务 ' + (i + 1) + '：';
      const target = targets.find(t => t.id === task.target_id);
      if (!target) { errors.push(label + '请选择部署目标'); return; }
      const available = variants({name: task.model_name, format: task.model_format}, target, catalogs);
      const model = available.find(m => m.version === task.model_version);
      const sku = model?.skus?.find(s => s.name === task.sku_name);
      if (!sku) errors.push(label + '请重新读取目录并选择该目标支持的模型版本 / SKU');
      const capacity = Number(task.capacity);
      if (!Number.isInteger(capacity) || capacity < (sku?.minimum || 1) || (sku?.maximum != null && capacity > sku.maximum) || (sku?.step && (capacity - (sku.minimum || 1)) % sku.step !== 0)) errors.push(label + '容量不符合所选 SKU 范围');
      const namingError = nameError('deployment_name', deploymentName(task, target));
      if (namingError) errors.push(label + namingError);
      const key = [target.subscription_id, target.resource_group, accountName(target), deploymentName(task, target)].join('|').toLowerCase();
      if (names.has(key)) errors.push(label + '部署名称重复');
      names.add(key);
    });
    return errors;
  }
  function payload(targets, tasks) {
    const used = new Set(tasks.map(t => t.target_id));
    return {targets: targets.filter(t => used.has(t.id)).map(targetPayload), tasks: tasks.map(t => taskPayload(t, targets))};
  }
  function canStandard(targets, tasks) {
    return new Set(targets.map(t => t.subscription_id)).size <= 1 && new Set(targets.map(t => t.location)).size === targets.length && tasks.every(t => !t.deployment_name);
  }
  function parseSP(text) {
    text = text.replace(/\\[ \t]*\r?\n/g, '\n'); // 仅移除真实换行前的续行符，保留密码末尾的反斜线。
    const aliases = {APP_ID: 'AZURE_CLIENT_ID', CLIENT_ID: 'AZURE_CLIENT_ID', AZURE_CLIENT_ID: 'AZURE_CLIENT_ID', PASSWORD: 'AZURE_CLIENT_SECRET', CLIENT_SECRET: 'AZURE_CLIENT_SECRET', AZURE_CLIENT_SECRET: 'AZURE_CLIENT_SECRET', TENANT_ID: 'AZURE_TENANT_ID', AZURE_TENANT_ID: 'AZURE_TENANT_ID'};
    const result = {};
    try {
      const parsed = JSON.parse(text); const raw = parsed.credentials || parsed;
      for (const [key, value] of Object.entries(raw)) if (aliases[key.toUpperCase()] && typeof value === 'string') result[aliases[key.toUpperCase()]] = value;
    } catch (_) {
      const keys = Object.keys(aliases).sort((a,b) => b.length-a.length).join('|');
      // Boundaries delimit fields, not arbitrary spaces inside an opaque secret.
      const re = new RegExp('(?:^|[\\s;])(?:export\\s+|set\\s+)?(' + keys + ')\\s*[:=]\\s*', 'gi');
      const matches = Array.from(text.matchAll(re));
      matches.forEach((m, i) => {
        let value = text.slice(m.index + m[0].length, matches[i+1]?.index ?? text.length).trim().replace(/[;\r\n]+$/, '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        const key = aliases[m[1].toUpperCase()];
        if (key in result && result[key] !== value) throw Error('SP 包含冲突的重复字段');
        result[key] = value;
      });
    }
    if (!result.AZURE_CLIENT_ID || !result.AZURE_CLIENT_SECRET || !result.AZURE_TENANT_ID) throw Error('未识别完整 SP，请粘贴 APP_ID、PASSWORD、TENANT_ID 或展开手动填写');
    return result;
  }
  const api = {uid, slug, joinName, fitName, nameError, groupNamePart, joinGroupName, newTarget, accountName, targetPayload, catalogKey, modelKey, variants, preferred, skuFor, assignModel, deploymentName, taskPayload, validateTargets, validateTasks, payload, canStandard, parseSP};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  scope.FoundryPlan = api;
})(globalThis);
