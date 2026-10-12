/* Local console controller. Credentials stay in memory, never localStorage. */
'use strict';
(() => {
  const P = window.FoundryPlan;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const opt = (value, label, selected) => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  const spinner = '<span class="spinner" aria-hidden="true"></span>';
  const S = {page: 1, mode: 'standard', credentials: null, epoch: 0, subscriptions: [], targets: [], tasks: [], bulkSubscription: '',
    resources: {}, projects: {}, catalogs: {}, revision: 0, checked: -1, preview: null, observations: [],
    naming: {prefix: '', base: '', start: '1', padding: '1', suffix: ''}, job: null, submitting: false, sequence: 0, modelLimit: 36, submitted: null, pendingRequest: '', pendingReceipt: null, deletePreview: null};
  const regions = {eastus:'美国东部',eastus2:'美国东部 2',westus:'美国西部',westus2:'美国西部 2',westus3:'美国西部 3',southcentralus:'美国中南部',northcentralus:'美国中北部',centralus:'美国中部',westcentralus:'美国中西部',canadacentral:'加拿大中部',canadaeast:'加拿大东部',brazilsouth:'巴西南部',mexicocentral:'墨西哥中部',swedencentral:'瑞典中部',westeurope:'西欧',northeurope:'北欧',uksouth:'英国南部',ukwest:'英国西部',francecentral:'法国中部',germanywestcentral:'德国中西部',switzerlandnorth:'瑞士北部',norwayeast:'挪威东部',polandcentral:'波兰中部',italynorth:'意大利北部',spaincentral:'西班牙中部',australiaeast:'澳大利亚东部',australiasoutheast:'澳大利亚东南部',newzealandnorth:'新西兰北部',japaneast:'日本东部',japanwest:'日本西部',koreacentral:'韩国中部',southeastasia:'东南亚',eastasia:'东亚',centralindia:'印度中部',southindia:'印度南部',indonesiacentral:'印度尼西亚中部',malaysiawest:'马来西亚西部',uaenorth:'阿联酋北部',qatarcentral:'卡塔尔中部',israelcentral:'以色列中部',southafricanorth:'南非北部'};
  const locked = () => S.submitting || ['running','recovery_required'].includes(S.job?.status) || !!S.pendingRequest;
  function notice(message, error = false) { $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = !message; }
  async function busy(button, label, operation) {
    if (button?.dataset.busy) return;
    const content = button?.innerHTML;
    if (button) { button.dataset.busy = 'true'; button.disabled = true; button.innerHTML = spinner + esc(label); button.setAttribute('aria-busy','true'); }
    try { return await operation(); } catch (error) { notice(error.message || '操作失败，请重试', true); }
    finally { if (button) { delete button.dataset.busy; button.removeAttribute('aria-busy'); button.innerHTML = content; button.disabled = false; } updateLocks(); }
  }
  async function api(path, body, timeout = 180000) {
    if (location.protocol === 'file:') throw Error('请通过「双击部署.cmd」启动本地控制台');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
      let data;
      try { data = await response.json(); } catch (_) { throw Error('本地服务响应异常，请重启部署.cmd 并刷新页面'); }
      if (!response.ok || data.ok === false) { const error = Error(data.message || '请求失败（' + response.status + '）'); error.definitive = response.status >= 400 && response.status < 500; throw error; }
      return data;
    } catch (error) { if (error.name === 'AbortError') throw Error('读取超时。部署请求可能仍在处理，请先刷新状态，不要重复提交。'); throw error; }
    finally { clearTimeout(timer); }
  }
  function withCredentials(data = {}) { if (!S.credentials) throw Error('请先连接 SP'); return {...data, credentials: {...S.credentials}}; }
  // 手动只读预检是辅助步骤；提交按钮依据当前计划完整性启用，后端仍复查目标。
  function deploymentTargets() { const ids=new Set(S.tasks.map(t=>t.target_id)); return S.targets.filter(t=>ids.has(t.id)); }
  const automaticGroup = t => t.group_mode === 'new' && !t.naming?.manual?.resource_group;
  function namingErrors(targets=S.targets) {
    const errors=[], automatic=targets.filter(automaticGroup), start=Number(S.naming.start);
    // 模板和序号仅约束自动命名的新资源组，不阻止手动名称或已有资源的部署。
    if(automatic.length && S.naming.base && (!Number.isInteger(start) || start<1 || start>999999)) errors.push('起始编号请输入 1–999999 的整数');
    for(const t of automatic) {
      if(t.naming?.sequenceError) errors.push(t.location+'：命名组编号请输入 1–999999 的整数');
      else if(start+Number(t.naming?.sequence||1)-1>999999) errors.push(t.location+'：最终编号超过 999999，请调整起始编号或命名组编号');
    }
    return errors;
  }
  function planErrors() { return [...namingErrors(deploymentTargets()), ...P.validateTargets(deploymentTargets()), ...P.validateTasks(S.targets,S.tasks,S.catalogs)]; }
  function dirty() { S.revision++; S.checked = -1; S.preview = null; S.observations = []; $('preflight').textContent = '计划已更新，可直接部署，也可先执行只读预检。'; updateLocks(); }
  function updateLocks() {
    const isLocked = locked();
    for (const container of ['page1','page2','page3','page4','confirmation']) {
      $(container).querySelectorAll('input,select,textarea,button').forEach(el => { if (isLocked) { if (!el.disabled) el.dataset.locked = '1'; el.disabled = true; } else if (el.dataset.locked) { delete el.dataset.locked; el.disabled = false; } });
    }
    document.querySelectorAll('[data-mode]').forEach(el => el.disabled = isLocked);
    $('deploy').disabled = isLocked || !!$('deploy').dataset.busy || !!$('checkPlan').dataset.busy || location.protocol === 'file:' || !S.credentials || planErrors().length > 0;
    $('retryFailed').disabled = isLocked;
    $('resourceManager').disabled = isLocked || !S.credentials;
    $('resolveSubmission').disabled = S.submitting || !!$('resolveSubmission').dataset.busy || !S.pendingRequest || !['unknown','accepted'].includes(S.pendingReceipt?.status) || ['running','recovery_required'].includes(S.job?.status);
  }
  function setPage(page) {
    if (page > 1 && !S.credentials && !(page === 5 && (S.pendingRequest || S.job && S.job.status !== 'idle'))) { notice('请先连接 Azure，读取订阅。', true); return; }
    S.page = page; document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page' + page));
    document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', +el.dataset.page === page); el.setAttribute('aria-current', +el.dataset.page === page ? 'step' : 'false'); });
    if (page === 2) renderTargets();
    if (page === 3) renderNamingTargets();
    if (page === 4) renderModels();
    if (page === 5) { renderPreview(); renderJob(); }
    updateLocks(); window.scrollTo({top:0,behavior:'smooth'});
  }
  function subscriptionLabel(id) { const sub = S.subscriptions.find(s => s.subscription_id === id); return sub?.display_name || id || '未选订阅'; }
  function targetLabel(t) { return t.location+(S.mode==='custom'?' · '+(t.label||'目标 '+(S.targets.indexOf(t)+1))+' · '+t.subscription_id.slice(0,8):''); }
  function subscriptionOptions(selected) {
    let html = opt('', '请选择订阅', selected);
    for (const sub of S.subscriptions) html += opt(sub.subscription_id, sub.display_name + ' · ' + sub.subscription_id.slice(0,8) + '…', selected);
    if (selected && !S.subscriptions.some(s => s.subscription_id === selected)) html += opt(selected, selected, selected);
    return html;
  }
  // 选区域仅生成候选目标；勾选模型—区域组合才生成实际任务。
  function renderRegionChoices() {
    const search=$('regionSearch').value.trim().toLowerCase(), selected=new Set(S.targets.map(t=>t.location));
    const codes=[...new Set([...Object.keys(regions),...selected])];
    $('regionChoices').innerHTML=codes.filter(c=>(c+' '+(regions[c]||'')).toLowerCase().includes(search)).map(c=>'<label class="region-choice'+(selected.has(c)?' selected':'')+'"><input type="checkbox" data-region="'+esc(c)+'"'+(selected.has(c)?' checked':'')+'><span><b>'+esc(c)+'</b><small>'+esc(regions[c]||c)+'</small></span></label>').join('')||'<div class="empty">没有匹配区域</div>';
    $('selectedRegions').innerHTML=S.targets.map(t=>'<button class="region-tag" data-remove-region="'+esc(t.location)+'" aria-label="移除'+esc(regions[t.location]||t.location)+'">'+esc(t.location)+' <small>'+esc(regions[t.location]||t.location)+'</small> ×</button>').join('');
    $('regionCount').textContent='已选 '+S.targets.length+' 个区域 / 最多 20 个';updateLocks();
  }
  function renderBulkRegions() {
    const standard=S.mode==='standard';
    $('standardModePanel').hidden=!standard;
    $('customModePanel').hidden=standard;
    $('bulkRegions').hidden=!standard;
    // 单一表单节点在选项卡间移动，保留名称、已有资源选择和事件处理。
    const mount=$(standard?'standardTargetMount':'customTargetMount');
    if($('targetSettings').parentElement!==mount)mount.appendChild($('targetSettings'));
    document.querySelectorAll('[data-mode]').forEach(tab=>{
      const active=tab.dataset.mode===S.mode;
      tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    });
    if(S.targets.length)S.bulkSubscription=S.targets[0].subscription_id;
    $('bulkSubscription').innerHTML=subscriptionOptions(S.bulkSubscription);
    $('targetSettingsTitle').textContent=S.mode==='standard'?'逐区域资源设置（可选）':'部署目标与已有资源';
    // 只在切换模式时应用初始展开状态，资源读取/选择后不折叠正在操作的表单。
    if($('targetSettings').dataset.mode!==S.mode){$('targetSettings').open=S.mode==='custom';$('targetSettings').dataset.mode=S.mode;}
    renderRegionChoices();
  }
  function changeRegion(code,selected) {
    if(locked())return;
    const t=S.targets.find(t=>t.location===code);
    if(selected&&!t) {
      if(S.targets.length>=20){notice('最多选择 20 个区域',true);renderRegionChoices();return;}
      const next=P.newTarget(S.bulkSubscription);next.location=code;S.targets.push(next);namingState(next);syncNaming(next);
    } else if(!selected&&t) {
      const count=S.tasks.filter(d=>d.target_id===t.id).length;
      if(count&&!confirm('移除 '+(regions[code]||code)+' 将从本次计划移除 '+count+' 条模型任务，不会删除 Azure 资源。继续？')){renderRegionChoices();return;}
      S.tasks=S.tasks.filter(d=>d.target_id!==t.id);S.targets=S.targets.filter(d=>d!==t);
    } else return;
    dirty();renderTargets();renderModels();notice('');
  }
  // 读取区域目录只需要订阅和区域，不要求先填写名称或创建资源组。
  function catalogErrors() {
    if(!S.targets.length)return ['请至少选择一个部署区域'];
    const errors=[];
    for(const t of S.targets) {
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(t.subscription_id))errors.push('请选择有效订阅');
      if(!t.location.trim())errors.push('请选择部署区域');
      if(t.account_mode==='existing'&&(!t.resource_group||!t.account_name))errors.push('请选择已有资源组和 Foundry');
    }
    return [...new Set(errors)];
  }
  function supportedVariants(model,target) { return P.variants(model,target,S.catalogs).filter(v=>v.skus?.length); }
  // 显式全选先完整校验，再一次写入；不覆盖已配置任务，也不部分添加。
  function addModelTargets(model,targets) {
    const key=P.modelKey(model),pending=[];
    const address=(t,d)=>[t.subscription_id,t.resource_group,P.accountName(t),P.deploymentName(d,t)].join('|').toLowerCase();
    for(const target of targets) {
      if(S.tasks.some(d=>d.target_id===target.id&&P.modelKey({name:d.model_name,format:d.model_format})===key))continue;
      if(!supportedVariants(model,target).length)throw Error('该区域暂无可部署的模型版本');
      const task=P.assignModel(model,[target],S.catalogs,S.tasks,S.sequence+pending.length+1);
      if([...S.tasks,...pending].some(d=>{const other=S.targets.find(t=>t.id===d.target_id);return other&&address(other,d)===address(target,task);}))throw Error('该 Foundry 已有同名部署任务，请调整部署名称或使用其它 Foundry。');
      pending.push(task);
    }
    if(S.tasks.length+pending.length>100)throw Error('单次最多 100 条任务，请减少区域或模型');
    S.sequence+=pending.length;S.tasks.push(...pending);
  }
  function selectField(title, field, value, options, disabled = false) { return '<label class="field"><span>' + esc(title) + '</span><select data-field="' + field + '"' + (disabled ? ' disabled' : '') + '>' + options + '</select></label>'; }
  function inputField(title, field, value, placeholder = '', disabled = false) { return '<label class="field"><span>' + esc(title) + '</span><input data-field="' + field + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" autocomplete="off"' + (disabled ? ' disabled' : '') + '></label>'; }
  function segment(t, key, labels) { return '<div class="segmented">' + ['new','existing'].map((mode,i) => '<button data-source="' + key + '" data-value="' + mode + '" class="' + (t[key] === mode ? 'active' : '') + '">' + labels[i] + '</button>').join('') + '</div>'; }
  function resourceState(t) {
    const entry = S.resources[t.subscription_id];
    if (entry?.status === 'loading') return '<div class="resource-state">' + spinner + '正在读取资源组与 Foundry…</div>';
    if (entry?.status === 'error') return '<div class="resource-state error">' + esc(entry.error) + ' <button class="quiet" data-action="resources">重试</button></div>';
    if (entry?.status === 'ready') return '<div class="resource-state">已读取 ' + entry.data.resource_groups.length + ' 个资源组' + (entry.data.warnings?.length ? ' · ' + esc(entry.data.warnings.join('；')) : '') + '</div>';
    return '<div class="resource-state">未读取已有资源。<button class="quiet" data-action="resources">读取资源组</button></div>';
  }
  function preserveOption(options, value, values) { return value && !values.includes(value) ? options + opt(value, value + '（待预检确认）', value) : options; }
  // 只给已有部署目标编号，不扩展目标或模型任务；移除目标后不重排编号。
  let nextNamingSequence = 0;
  function namingState(t) {
    t.naming ||= {};
    t.naming.manual ||= {};
    t.naming.auto ||= {};
    if (!t.naming.sequence) {
      const used = S.targets.filter(x => x !== t).map(x => Number(x.naming?.sequence) || 0);
      t.naming.sequence = Math.max(nextNamingSequence, 0, ...used) + 1;
    }
    nextNamingSequence = Math.max(nextNamingSequence, Number(t.naming.sequence) || 0);
    return t.naming;
  }
  function namingNumber(t) {
    const state=namingState(t); if(state.sequenceError)return '';
    const start = Number(S.naming.start), offset = Number(state.sequence) - 1;
    return Number.isInteger(start) && start >= 1 && start + offset <= 999999 ? String(start + offset).padStart(Number(S.naming.padding), '0') : '';
  }
  function syncNaming(t) {
    const n = namingState(t), number = namingNumber(t), base = P.groupNamePart(S.naming.base);
    const group = base && number ? P.fitName(P.joinGroupName(S.naming.prefix, base, number, S.naming.suffix), 90) : '';
    // 已有资源保持原名；手动值优先，只更新空值或上次自动生成的值。
    function set(field, mode, value) {
      if (t[mode] !== 'new') return;
      if (t[field] && t[field] !== n.auto[field]) n.manual[field] = true;
      if (n.manual[field]) return;
      t[field] = value;
      n.auto[field] = value;
    }
    set('resource_group', 'group_mode', group);
    set('account_name', 'account_mode', t.resource_group && t.location ? P.fitName(P.joinName(t.resource_group, t.location), 64) : '');
    set('project_name', 'project_mode', t.account_name ? P.fitName(P.joinName(t.account_name, 'project'), 64) : '');
  }
  function updateNamingPreview(card, t) {
    const n = namingState(t);
    for (const [field, selector, fallback] of [
      ['resource_group','[data-preview-group]','待设置'],
      ['account_name','[data-preview-account]','待设置'],
      ['project_name','[data-preview-project]','待设置']]) {
      if (card.querySelector(selector)) card.querySelector(selector).textContent = t[field] || fallback;
      const error = P.nameError(field, t[field] || '');
      const message = card.querySelector('[data-name-error="' + field + '"]');
      if (message) { message.textContent = error; message.hidden = !error; }
      const input = card.querySelector('input[data-field="' + field + '"]');
      if (input && input !== document.activeElement) input.value = t[field];
    }
    const sequenceInput=card.querySelector('[data-field="naming.sequence"]');
    if(sequenceInput){
      if(sequenceInput!==document.activeElement) sequenceInput.value=n.sequenceError ? n.sequenceDraft : n.sequence;
      sequenceInput.disabled=!automaticGroup(t);delete sequenceInput.dataset.locked;
      sequenceInput.setCustomValidity(automaticGroup(t)&&n.sequenceError?'请输入 1–999999 的整数':'');
    }
    const sequenceError=card.querySelector('[data-sequence-error]');
    if(sequenceError){sequenceError.textContent=automaticGroup(t)&&n.sequenceError?'请输入 1–999999 的整数':'';sequenceError.hidden=!sequenceError.textContent;}
    const newFields=[['resource_group','group_mode'],['account_name','account_mode'],['project_name','project_mode']].filter(([,mode])=>t[mode]==='new');
    if (card.querySelector('[data-name-note]')) card.querySelector('[data-name-note]').textContent = !newFields.length
      ? '沿用已有资源名称' : newFields.some(([field])=>n.manual[field]) ? '含手动名称，自动更新不覆盖' : '名称自动更新，可直接修改';
  }
  function refreshNaming() {
    for (const t of S.targets) {
      syncNaming(t);
      const card = $('targets').querySelector('[data-target="' + t.id + '"]');
      if (card) updateNamingPreview(card, t);
      const nameCard = $('namingTargets').querySelector('[data-target="' + t.id + '"]');
      if (nameCard) updateNamingPreview(nameCard, t);
    }
    // 预览只包含名称，不包含 SP、密钥或其它部署参数。
    $('namingJson').textContent = JSON.stringify(S.targets.map(t => ({
      target: t.label || '部署目标 ' + (S.targets.indexOf(t) + 1),
      naming_group: automaticGroup(t) ? namingState(t).sequence : null, region: t.location,
      resource_group: t.resource_group, foundry_name: t.account_name, project_name: t.project_name
    })), null, 2);
    const newGroups=S.targets.filter(t=>t.group_mode==='new'), automatic=newGroups.filter(automaticGroup);
    $('groupNamingTemplate').hidden=!newGroups.length;
    $('namingStatus').textContent = namingErrors()[0] || (automatic.length && S.naming.base && !P.groupNamePart(S.naming.base)
      ? '业务名称请使用英文、数字、短横线或下划线'
      : !newGroups.length ? '资源组沿用已有名称；仅需核对下方 Foundry / Project。'
      : !automatic.length ? '资源组均使用手动名称，模板不会覆盖；可逐目标恢复自动命名。'
      : '自动命名 '+automatic.length+' 个新资源组；移除目标不重排编号。');
  }
  function renderNamingTargets() {
    $('namingTargets').innerHTML = S.targets.map((t,index) => {
      const n=namingState(t), hasNew=[t.group_mode,t.account_mode,t.project_mode].includes('new');
      const fields=[
        ['resource_group','group_mode','资源组','1–90 字符；保留业务名大小写'],
        ['account_name','account_mode','Foundry','2–64 字符；自动名称超长时保留稳定后缀'],
        ['project_name','project_mode','Project','2–64 字符；项目名称不是模型部署名称']
      ].map(([field,mode,label,hint]) => '<div>' + (t[mode] === 'existing'
        ? '<label class="field">'+label+' · 使用已有<code class="existing-name">'+esc(t[field]||'请返回上一页选择')+'</code></label>'
        : inputField(label+' *',field,t[field])) + '<small class="hint">'+(t[mode]==='existing'?'保留原名称，无需再次填写':hint)+'</small><small class="hint error" data-name-error="'+field+'"></small></div>').join('');
      const sequence=t.group_mode==='new' ? '<label class="field">命名组编号<input type="number" min="1" max="999999" data-field="naming.sequence" value="'+esc(n.sequenceError?n.sequenceDraft:n.sequence)+'"'+(!automaticGroup(t)?' disabled':'')+'><small class="hint">自动编号 = 起始编号 + 此编号 − 1；相同编号可共用资源组</small><small class="hint error" data-sequence-error></small></label>' : '';
      return '<article class="panel naming-card" data-target="'+esc(t.id)+'"><h3>'+esc(t.location)+'<small class="hint"> · '+esc(regions[t.location]||'')+' · '+esc(t.label||'目标 '+(index+1))+' · '+esc(subscriptionLabel(t.subscription_id))+'</small></h3><div class="naming-resource-grid">'+fields+'</div><div class="naming-target-tools">'+sequence+'<span class="hint" data-name-note></span>'+(hasNew?'<button class="secondary" data-action="reset-names">恢复新建项的自动命名</button>':'')+'</div></article>';
    }).join('') || '<div class="empty">请先选择部署目标。</div>';
    refreshNaming(); updateLocks();
  }

  function renderTargets() {
    S.targets.forEach(syncNaming);
    $('addTarget').hidden = S.mode !== 'custom';
    $('modeDescription').textContent=S.mode==='standard'?'选订阅 → 多选区域 → 选择模型及其部署区域。':'独立设置多个订阅、区域及已有资源。';
    renderBulkRegions();
    document.querySelectorAll('[data-mode]').forEach(el => el.classList.toggle('active', el.dataset.mode === S.mode));
    $('targets').innerHTML = S.targets.map((t, i) => {
      const r = S.resources[t.subscription_id]; const groups = r?.data?.resource_groups || [];
      const accounts = (r?.data?.foundry_accounts || []).filter(a => a.resource_group.toLowerCase() === t.resource_group.toLowerCase() && a.kind === 'AIServices' && a.allow_project_management === true);
      const regionOptions = Object.entries(regions).map(([id,label]) => opt(id,label + ' · ' + id,t.location)).join('') + (!regions[t.location] && t.location ? opt(t.location,t.location,t.location) : '');
      let groupOptions = opt('', r?.status === 'ready' && !groups.length ? '该订阅没有可读取的资源组' : '请选择已有资源组',t.resource_group) + groups.map(g => opt(g.name,g.name + ' · ' + g.location,t.resource_group)).join('');
      groupOptions = preserveOption(groupOptions,t.resource_group,groups.map(g => g.name));
      const accountOptions = preserveOption(opt('', accounts.length ? '请选择 Foundry' : '该资源组没有可用 Foundry，可选择新建',t.account_name) + accounts.map(a => opt(a.name,a.name + ' · ' + a.location,t.account_name)).join(''), t.account_name,accounts.map(a => a.name));
      const projects = S.projects[P.catalogKey(t)]; const names = projects?.data?.projects || [];
      const projectOptions = preserveOption(opt('', projects?.status === 'loading' ? '正在读取 Project…' : '请选择已有 Project',t.project_name) + names.map(p => opt(p.name,p.name,t.project_name)).join(''),t.project_name,names.map(p => p.name));
      return '<article class="target-card" data-target="' + t.id + '"><div class="target-header"><h3><span class="number">' + String(i+1).padStart(2,'0') + '</span>' + esc(t.label || '部署目标 ' + (i+1)) + '</h3><div class="toolbar"><button class="quiet" data-action="resources">刷新已有资源</button>' + (S.mode === 'custom' ? '<button class="quiet" data-action="remove-target">移除目标</button>' : '') + '</div></div><div class="target-body">' +
        (S.mode==='custom'?'<div class="grid2">' + selectField('Azure 订阅','subscription_id',t.subscription_id,subscriptionOptions(t.subscription_id)) + selectField('部署区域','location',t.location,regionOptions,t.account_mode === 'existing' && !!t.account_name) + '</div>':'<p class="target-region-heading">'+esc(targetLabel(t))+'</p>') +
        (S.mode === 'custom' ? '<details><summary>目标备注 / 其它区域</summary><div class="grid2">' + inputField('目标备注','label',t.label,'例如：客户 A · 主区域') + inputField('区域代码','location',t.location,'例如 eastus',t.account_mode === 'existing' && !!t.account_name) + '</div></details>' : '') +
        '<div class="target-section"><h3>资源组</h3>' + segment(t,'group_mode',['新建资源组','使用已有资源组']) +
        (t.group_mode === 'new' ? '<p class="hint">下一页设置资源组名称。</p>' : resourceState(t) + selectField('已有资源组 *','resource_group',t.resource_group,groupOptions,r?.status === 'loading')) + '</div>' +
        '<div class="target-section"><div class="grid2"><div><h3>Foundry 资源</h3>' + (t.group_mode === 'existing' ? segment(t,'account_mode',['新建 Foundry','使用已有 Foundry']) : '<p class="hint">自动创建；同名兼容资源会在预检中提示复用。</p>') +
        (t.account_mode === 'existing' ? selectField('已有 Foundry *','account_name',t.account_name,accountOptions,r?.status === 'loading') + '<p class="hint selection-note">区域跟随所选 Foundry。</p>' : '<p class="hint">下一页自动生成或自定义名称。</p>') + '</div><div><h3>Project 项目</h3>' +
        (t.account_mode === 'existing' ? segment(t,'project_mode',['新建 Project','使用已有 Project']) : '<p class="hint">项目名称独立于模型部署名称。</p>') +
        (t.project_mode === 'existing' ? selectField('已有 Project *','project_name',t.project_name,projectOptions,projects?.status === 'loading') + '<button class="quiet" data-action="projects">' + (projects?.status === 'loading' ? spinner : '') + '刷新 Project</button>' + (projects?.status === 'error' ? '<p class="hint error">' + esc(projects.error) + '</p>' : projects?.status === 'ready' && !names.length ? '<p class="hint">没有 Project，可以切换到新建。</p>' : '') : '<p class="hint">下一页设置 Project 名称。</p>') + '</div></div></div>' +
        '</div></article>';
    }).join(''); refreshNaming(); updateLocks();
  }
  function switchSource(t, key, value) {
    if(t[key]===value)return;
    if(!confirmTargetChange(t,'资源来源'))return;
    const field = {group_mode:'resource_group',account_mode:'account_name',project_mode:'project_name'}[key];
    t.drafts[key + ':' + t[key]] = t[field]; t[key] = value; t[field] = t.drafts[key + ':' + value] || '';
    if (key === 'group_mode') {
      // 已选的 Foundry 不可跨资源组沿用；仍属“新建”的手动名称则保留。
      delete t.drafts['account_mode:existing'];delete t.drafts['project_mode:existing'];
      if(t.account_mode==='existing')t.account_name=t.drafts['account_mode:new']||'';
      t.account_mode='new';
      if(t.project_mode==='existing')t.project_name=t.drafts['project_mode:new']||'';
      t.project_mode='new';
    }
    if (key === 'account_mode') { delete t.drafts['project_mode:existing']; if (t.project_mode === 'existing') t.project_name=t.drafts['project_mode:new']||''; t.project_mode='new'; }
    // 切换资源来源导致新建名称被清空时，解除旧来源的手动标记。
    const naming = namingState(t);
    for (const [name, mode] of [['resource_group','group_mode'],['account_name','account_mode'],['project_name','project_mode']]) {
      if (t[mode] === 'new' && !t[name]) { delete naming.manual[name]; delete naming.auto[name]; }
    }
    dirty(); renderTargets();
    if (key === 'group_mode' && value === 'existing' && S.resources[t.subscription_id]?.status !== 'ready') loadResources(t.subscription_id);
    if (key === 'project_mode' && value === 'existing') loadProjects(t);
  }
  // 已选任务不会静默迁移到别的订阅/区域/已有资源；更改后重新核对目录。
  function confirmTargetChange(t,label,extra='') {
    const count=S.tasks.filter(task=>task.target_id===t.id).length;
    const impact=count?'更改'+label+'将影响此目标的 '+count+' 条模型任务。任务保留，但需要重新核对模型目录和最终计划；不会移动已部署的 Azure 资源。':'';
    return !count&&!extra || confirm([extra,impact,'继续？'].filter(Boolean).join('\n'));
  }
  function changeTargetField(t,key,value) {
    if(t[key]===value)return true;
    let account=null, regionNotice='';
    if(key==='account_name' && t.account_mode==='existing') {
      account=S.resources[t.subscription_id]?.data?.foundry_accounts?.find(a=>a.name===value&&a.resource_group.toLowerCase()===t.resource_group.toLowerCase());
      if(account && account.location!==t.location) {
        if(S.mode==='standard'&&S.targets.some(other=>other!==t&&other.location===account.location)) {
          notice('该 Foundry 位于 '+account.location+'，已有同区域目标。请切换自定义模式，或在原目标中选择它。',true);return false;
        }
        regionNotice='所选 Foundry 位于 '+account.location+'；此目标区域将由 '+t.location+' 改为 '+account.location+'。';
      }
    }
    if(!confirmTargetChange(t,({subscription_id:'订阅',location:'部署区域',resource_group:'资源组',account_name:'Foundry',project_name:'Project'})[key]||'目标',regionNotice))return false;
    if(key==='subscription_id') {
      t.subscription_id=value;if(t.group_mode==='existing')t.resource_group='';if(t.account_mode==='existing')t.account_name='';if(t.project_mode==='existing')t.project_name='';t.drafts={};
    } else if(key==='resource_group') {
      t.resource_group=value;if(t.account_mode==='existing')t.account_name='';if(t.project_mode==='existing')t.project_name='';delete t.drafts['account_mode:existing'];delete t.drafts['project_mode:existing'];
    } else if(key==='account_name') {
      t.account_name=value;if(account)t.location=account.location;if(t.project_mode==='existing')t.project_name='';delete t.drafts['project_mode:existing'];
    } else t[key]=value;
    dirty();renderTargets();renderModels();
    if(t.group_mode==='existing')loadResources(t.subscription_id);
    if(t.project_mode==='existing'&&t.account_name)loadProjects(t);
    return true;
  }
  async function loadResources(subscription, force=false) {
    if (!subscription) { notice('请先选择订阅',true); return; }
    const old = S.resources[subscription]; if (old?.status === 'loading' || (!force && old?.status === 'ready')) return;
    const epoch=S.epoch; const entry={status:'loading'}; S.resources[subscription]=entry; renderTargets();
    try { const data=await api('/api/lookup-subscription',withCredentials({subscription_id:subscription})); if(epoch!==S.epoch || S.resources[subscription]!==entry) return; entry.status='ready'; entry.data=data; }
    catch(error) { if(epoch!==S.epoch) return; entry.status='error'; entry.error=error.message; }
    finally { if(epoch===S.epoch) { renderTargets(); if($('resourceDialog').open) renderManagerGroups(); } }
  }
  async function loadProjects(t, force=false) {
    if (!t.account_name) return;
    const key=P.catalogKey(t), epoch=S.epoch;
    if(S.projects[key]?.status==='loading'||(!force&&S.projects[key]?.status==='ready')) return;
    const entry={status:'loading'}; S.projects[key]=entry; renderTargets();
    try { const data=await api('/api/lookup-projects',withCredentials({subscription_id:t.subscription_id,resource_group:t.resource_group,account_name:t.account_name})); if(epoch!==S.epoch) return; entry.status='ready'; entry.data=data; }
    catch(error) { if(epoch!==S.epoch) return; entry.status='error'; entry.error=error.message; }
    finally { if(epoch===S.epoch) renderTargets(); }
  }
  function allModels() {
    const map=new Map();
    for(const t of S.targets) { const entry=S.catalogs[P.catalogKey(t)]; if(entry?.status!=='ready') continue;
      for(const m of entry.models) { const key=P.modelKey(m); if(!map.has(key)) map.set(key,{name:m.name,format:m.format,targets:[]}); const item=map.get(key); if(!item.targets.includes(t.id)) item.targets.push(t.id); }
    }
    return Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name));
  }
  function renderCatalog() {
    const items=allModels(); const search=$('modelSearch').value.trim().toLowerCase(), target=$('catalogTarget').value,publisher=$('publisherFilter').value;
    const coverage=$('coverageFilter').value;
    const filtered=items.filter(m=>{const count=S.targets.filter(t=>supportedVariants(m,t).length).length;return (!search||(m.name+' '+m.format).toLowerCase().includes(search))&&(!target||m.targets.includes(target))&&(!publisher||m.format===publisher)&&(!coverage||(coverage==='all'?count===S.targets.length:count>0&&count<S.targets.length));});
    const selectedModels=new Set(S.tasks.map(t=>P.modelKey({name:t.model_name,format:t.model_format})));
    const selectedTargets=new Set(S.tasks.map(t=>t.target_id));
    const selectedRegions=new Set(S.targets.filter(t=>selectedTargets.has(t.id)).map(t=>t.location));
    $('catalogCount').textContent='当前 '+filtered.length+' 个模型 · 已选 '+selectedModels.size+' 种模型 / '+selectedRegions.size+' 个区域'+(S.mode==='custom'?' / '+selectedTargets.size+' 个目标':'')+' / 共 '+S.tasks.length+' 条任务';
    $('catalog').innerHTML=filtered.length?filtered.slice(0,S.modelLimit).map(m=>{
      const key=P.modelKey(m),matches=S.tasks.filter(t=>P.modelKey({name:t.model_name,format:t.model_format})===key);
      const targets=S.targets.map(t=>{
        const entry=S.catalogs[P.catalogKey(t)],variants=supportedVariants(m,t),available=variants.length>0;
        const current=matches.find(d=>d.target_id===t.id),version=variants.find(v=>v.version===current?.model_version)||P.preferred(variants),sku=version?.skus?.find(s=>s.name===current?.sku_name)||P.skuFor(version);
        const detail=available?version.version+' · '+(sku?.name||''):'';
        const count=matches.filter(task=>task.target_id===t.id).length;
        const reason=available?'':entry?.status==='ready'?'该目标目录不支持此模型':entry?.status==='loading'?'目录读取中':entry?.status==='error'?'目录读取失败，请刷新':'请先读取目录';
        return '<label class="model-target-choice'+(!available?' unavailable':'')+'"><input type="checkbox" data-model-target="'+esc(key)+'" data-target-id="'+esc(t.id)+'"'+(count?' checked':'')+(!available?' disabled':'')+'><span><b>'+esc(targetLabel(t))+'</b><small>'+esc([regions[t.location],reason||detail].filter(Boolean).join(' · '))+(count>1?' · '+count+' 条任务':'')+'</small></span></label>';
      }).join('');
      const availableTargets=S.targets.filter(t=>supportedVariants(m,t).length),missing=availableTargets.filter(t=>!matches.some(d=>d.target_id===t.id)).length;
      return '<article class="model-card model-assignment'+(matches.length?' selected':'')+'"><div class="model-assignment-heading"><div><strong>'+esc(m.name)+'</strong><small>'+esc(m.format)+'</small></div><span class="badge">'+matches.length+' 条任务</span></div><div class="model-region-summary"><span>'+availableTargets.length+' / '+S.targets.length+' 个目标支持</span><button class="quiet" data-all-model="'+esc(key)+'"'+(!missing?' disabled':'')+'>全选可用'+(S.mode==='standard'?'区域':'目标')+'</button></div><div class="model-target-choices">'+targets+'</div></article>';
    }).join(''):'<div class="empty">'+(Object.values(S.catalogs).some(e=>e.status==='loading')?spinner+'正在读取模型目录…':items.length?'没有匹配的模型，试试其它关键词。':'还没有模型目录。请读取目标区域；接口错误会显示在上方。')+'</div>';
    $('catalogPager').innerHTML=filtered.length>S.modelLimit?'<button class="secondary" id="moreModels">显示更多（剩余 '+(filtered.length-S.modelLimit)+'）</button>':'';
    updateLocks();
  }
  function renderModels() {
    const selected=$('catalogTarget').value,publisher=$('publisherFilter').value;
    $('catalogTarget').innerHTML=opt('','全部目标',selected)+S.targets.map(t=>opt(t.id,targetLabel(t),selected)).join('');
    $('publisherFilter').innerHTML=opt('','全部提供方',publisher)+Array.from(new Set(allModels().map(m=>m.format))).sort().map(f=>opt(f,f,publisher)).join('');
    $('catalogStates').innerHTML=S.targets.map(t=>{const e=S.catalogs[P.catalogKey(t)];return '<div class="catalog-state '+(e?.status==='error'?'error':'')+'">'+(e?.status==='loading'?spinner:'')+esc(targetLabel(t))+' · '+(e?.status==='ready'?e.models.length+' 个版本':e?.status==='error'?esc(e.error):e?.status==='loading'?'读取中':'未读取')+'</div>';}).join('');
    renderCatalog(); renderTasks();
  }
  async function loadCatalogs(force=false) {
    const errors=catalogErrors(); if(errors.length) throw Error(errors.join('\n'));
    const epoch=S.epoch; const unique=new Map(S.targets.map(t=>[P.catalogKey(t),{...t}])); const queue=Array.from(unique.entries());
    async function worker() { while(queue.length) { const [key,t]=queue.shift();
      if(S.catalogs[key]?.status==='loading'||(!force&&S.catalogs[key]?.status==='ready')) continue;
      const entry={status:'loading'}; S.catalogs[key]=entry; dirty(); renderModels();
      try { const payload=t.account_mode==='existing'?{subscription_id:t.subscription_id,resource_group:t.resource_group,account_name:t.account_name}:{subscription_id:t.subscription_id,location:t.location};
        const data=await api(t.account_mode==='existing'?'/api/lookup-models':'/api/lookup-region-models',withCredentials(payload));
        if(epoch!==S.epoch) return; entry.status='ready'; entry.models=data.models||[];
      } catch(error) { if(epoch!==S.epoch) return; entry.status='error'; entry.error=error.message; }
      if(epoch===S.epoch) renderModels();
    }}
    await Promise.all(Array.from({length:Math.min(queue.length,3)},worker));
  }
  function renderTasks() {
    $('taskCount').textContent=S.tasks.length;
    $('tasks').innerHTML=S.tasks.length?S.tasks.map((task,i)=>{
      const target=S.targets.find(t=>t.id===task.target_id); const variants=target?P.variants({name:task.model_name,format:task.model_format},target,S.catalogs):[];
      const model=variants.find(v=>v.version===task.model_version); const skus=model?.skus||[];
      const options=S.targets.map(t=>{const supported=P.variants({name:task.model_name,format:task.model_format},t,S.catalogs).some(m=>m.skus?.length);return '<option value="'+esc(t.id)+'"'+(t.id===task.target_id?' selected':'')+(!supported?' disabled':'')+'>'+esc(targetLabel(t)+(supported?'':' · 不支持 / 未读取'))+'</option>';}).join('');
      const versions=Array.from(new Set(variants.map(v=>v.version)));
      const versionOptions=preserveOption(versions.map(v=>opt(v,v,task.model_version)).join(''),task.model_version,versions);
      const skuOptions=preserveOption(skus.map(s=>opt(s.name,s.name,task.sku_name)).join(''),task.sku_name,skus.map(s=>s.name));
      return '<article class="task" data-task="'+task.id+'"><div class="task-top"><div class="task-title"><strong>'+String(i+1).padStart(2,'0')+' · '+esc(task.model_name)+'</strong><small>'+esc(task.model_format)+' · '+esc(task.model_version)+' · '+esc(task.sku_name)+' · capacity '+esc(task.capacity)+'</small></div>'+selectField('部署目标','target_id',task.target_id,options,S.mode==='standard')+'<div class="toolbar">'+'<button class="quiet" data-task-action="remove">移除</button></div></div>'+
        (!model||!skus.some(s=>s.name===task.sku_name)?'<p class="hint error">此任务的版本或 SKU 未通过当前目标目录校验，请刷新目录或重新选择。</p>':'')+
        (S.mode==='custom'?'<details><summary>版本、容量与模型部署名称</summary><div class="task-options">'+selectField('版本','model_version',task.model_version,versionOptions)+selectField('SKU','sku_name',task.sku_name,skuOptions)+inputField('容量（capacity）','capacity',task.capacity)+inputField('部署名称（留空使用模型名称）','deployment_name',task.deployment_name,target?P.deploymentName({...task,deployment_name:''},target):'')+'</div></details>':'')+
        '<div class="name-preview"><div><span>预计模型部署名称</span><code>'+esc(target?P.deploymentName(task,target):'请重新选择目标')+'</code></div></div>'+
        (task.model_format.toLowerCase()==='openai'?'<label class="guard-control"><input type="checkbox" data-field="guard"'+(task.rai_policy_name==='foundry-console-guard-low-v1'?' checked':'')+'> 内容防护 <span class="hint">打开：低阈值拦截；关闭：仅高风险阈值，不代表关闭 Azure 审核。</span></label>':'<p class="hint">该模型使用平台 / 提供方支持的默认内容安全设置。</p>')+'</article>';
    }).join(''):'<div class="empty">在上方模型卡片中勾选部署目标，即可添加任务。</div>'; updateLocks();
  }
  function reassign(task, targetId) {
    const target=S.targets.find(t=>t.id===targetId);
    if(!target){notice('请选择有效部署目标',true);return;}
    const variants=P.variants({name:task.model_name,format:task.model_format},target,S.catalogs);
    if(!variants.length){notice('该目标目录未包含此模型。原部署目标未改变。',true);return;}
    const name=P.deploymentName(task,target);
    if(S.tasks.some(t=>t.id!==task.id&&(()=>{const other=S.targets.find(x=>x.id===t.target_id);return other&&[other.subscription_id,other.resource_group,P.accountName(other),P.deploymentName(t,other)].join('|').toLowerCase()===[target.subscription_id,target.resource_group,P.accountName(target),name].join('|').toLowerCase();})())){
      notice('该 Foundry 已有同名部署任务，请先调整部署名称或移除重复项。原目标未改变。',true);return;
    }
    const model=variants.find(m=>m.version===task.model_version)||P.preferred(variants),sku=model.skus.find(s=>s.name===task.sku_name)||P.skuFor(model);
    const capacity=Number(task.capacity),minimum=sku.minimum||1;
    const valid=Number.isInteger(capacity)&&capacity>=minimum&&(sku.maximum==null||capacity<=sku.maximum)&&(!sku.step||(capacity-minimum)%sku.step===0)&&(!sku.allowedValues?.length||sku.allowedValues.includes(capacity));
    const nextCapacity=valid?task.capacity:String(minimum);
    if(model.version!==task.model_version||sku.name!==task.sku_name||nextCapacity!==task.capacity){
      if(!confirm('目标区域需要调整参数：版本 '+task.model_version+' → '+model.version+'；SKU '+task.sku_name+' → '+sku.name+'；容量 '+task.capacity+' → '+nextCapacity+'。确认切换？'))return;
    }
    task.target_id=targetId;task.model_version=model.version;task.sku_name=sku.name;task.capacity=nextCapacity;
  }
  function options() { return {register_provider:$('registerProvider').checked,update_existing:$('updateExisting').checked,skip_quota_check:$('skipQuota').checked,max_concurrency:Number($('concurrency').value)}; }
  function renderPreview() {
    $('planCount').textContent=new Set(S.tasks.map(t=>P.modelKey({name:t.model_name,format:t.model_format}))).size+' 种模型 · '+new Set(deploymentTargets().map(t=>t.location)).size+' 个区域 · '+S.tasks.length+' 条任务';
    const rows=S.preview?.deployments || S.tasks.map(task=>{const target=S.targets.find(t=>t.id===task.target_id);return target?{...P.targetPayload(target),...P.taskPayload(task,S.targets)}:null;}).filter(Boolean);
    $('planPreview').innerHTML=rows.length?'<table><thead><tr><th>模型 / 部署名称</th><th>订阅 / 区域</th><th>资源组</th><th>Foundry / Project</th><th>版本 / SKU / 容量</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><b>'+esc(row.model_name)+'</b><small>'+esc(row.deployment_name)+'</small></td><td>'+esc(subscriptionLabel(row.subscription_id))+'<small>'+esc(row.subscription_id)+'<br>'+esc(row.location)+'</small></td><td>'+esc(row.resource_group)+'<small>'+(row.resource_group_mode==='existing'||row.group_mode==='existing'?'使用已有':'新建 / 兼容则复用')+'</small></td><td>'+esc(row.account_name)+'<small>Project · '+esc(row.project_name)+'</small></td><td>'+esc(row.model_version)+'<small>'+esc(row.sku_name)+' · '+esc(row.capacity)+'</small></td></tr>').join('')+'</tbody></table>':'<div class="empty">尚未配置模型任务。</div>';
    if($('advancedOptions').dataset.mode!==S.mode){$('advancedOptions').open=S.mode==='custom';$('advancedOptions').dataset.mode=S.mode;}
    if(S.checked===S.revision) $('preflight').innerHTML='<strong class="success-text">✓ 目标只读预检通过</strong>'+S.observations.map(o=>'<div class="preflight-item">'+esc(o.label)+' · 资源组'+(o.group_action==='reuse'?'复用':'新建')+' · Foundry'+(o.account_action==='reuse'?'复用':'新建')+' · Project'+(o.project_action==='reuse'?'复用':'新建')+'</div>').join('')+'<span class="hint">已核对资源存在性、类型和区域；写权限、实时配额及模型供应情况由 Azure 部署时最终确认。</span>';
    updateLocks();
  }
  async function previewPlan(check=false) {
    const errors=planErrors();
    if(errors.length) throw Error(errors.join('\n'));
    const revision=S.revision,epoch=S.epoch, payload={...P.payload(S.targets,S.tasks),options:options()};
    const data=await api(check?'/api/check-plan':'/api/preview-plan',check?withCredentials(payload):payload);
    if(revision!==S.revision||epoch!==S.epoch) throw Error('计划已修改，请重新预检。');
    S.preview=data;
    if(check) {S.checked=revision; S.observations=data.observations||[];}
    renderPreview();
  }
  function renderJob() {
    const job=S.job||{status:'idle',message:'尚未开始部署'}, idle=job.status==='idle', c=job.counts||{};
    $('jobSummary').innerHTML=[['总任务',job.total||0],['成功',c.success||0],['失败',c.failed||0],['未执行',c.not_run||0],['待核实',c.unknown||0],['执行中',c.running||0],['排队',c.pending||0]].map(([label,count])=>'<div><small>'+label+'</small><b>'+count+'</b></div>').join('');
    $('acknowledgeRecovery').hidden=job.status!=='recovery_required';
    const canResolve=S.pendingRequest && ['unknown','accepted'].includes(S.pendingReceipt?.status) && !['running','recovery_required'].includes(job.status);
    $('resolveSubmission').hidden=!canResolve;
    $('pendingSubmission').hidden=!S.pendingRequest;
    if(S.pendingRequest) {
      const receipt=S.pendingReceipt;
      const text=receipt?.status==='checking'?'本次提交仍在预检或接收中，请等待，不要重复提交。'
        : receipt?.status==='accepted'?'本次请求已有接收回执，但不对应当前显示的批次。请先核实原批次和 Azure 状态。'
        : receipt?.status==='unknown'?'本次提交结果尚未确认。恢复连接后刷新状态；若服务曾重启，请先核实 Azure 和原部署进程。'
        : '正在查询本次提交的接收记录，请勿重复部署。';
      $('pendingSubmission').textContent=text+(canResolve?' 核实后可结束本地等待；此操作不取消云端请求。':'')+(!idle?' 下方显示本地最近一个批次。':'');
    }
    $('jobMessage').textContent=(job.message||'尚未开始部署')+(job.status==='running'?' · 排队 '+(c.pending||0)+' 项':'');
    $('jobProgress').style.width=(job.total?Math.round((job.completed||0)/job.total*100):0)+'%';
    $('jobProgress').parentElement.classList.toggle('running',job.status==='running');
    const success=new Set(['created','updated','unchanged']);
    $('jobEntries').innerHTML=(job.entries||[]).map(e=>'<div class="result-row"><div><b>'+esc(e.row.model_name)+'</b><small>'+esc(e.row.location)+' · '+esc(e.row.deployment_name)+'</small></div><span class="status-pill '+(success.has(e.status)?'ok':e.status==='running'?'running':['pending','starting'].includes(e.status)?'':'fail')+'">'+(e.status==='running'?spinner:'')+esc(e.stage)+'</span><div class="result-error">'+esc(e.error||'')+'</div></div>').join('');
    $('logs').textContent=(job.logs||[]).join('\n')||'尚无日志';
    $('jsonResult').textContent=job.report?JSON.stringify(job.report,null,2):idle?'尚无结果':'报告尚未生成；正在等待部署脚本。';
    $('downloads').innerHTML=(job.files||[]).filter(f=>/^results_[A-Za-z0-9_-]+\.(csv|json)$/.test(f.name)).map(f=>'<a class="download" href="/api/download/'+encodeURIComponent(f.name)+'" download>'+esc(f.name.split('.').pop().toUpperCase())+'</a>').join('');
    $('retryFailed').hidden=['running','recovery_required'].includes(job.status)||!!S.pendingRequest||!(job.entries||[]).some(e=>['failed','auth_failed','config_failed','not_run'].includes(e.status));
    updateLocks();
  }
  // 仅保存请求标识用于刷新后找回；SP、密钥和客户计划不存浏览器持久存储。
  function persistRequest() { try { if(S.pendingRequest)sessionStorage.setItem('foundry.pending-request',S.pendingRequest);else sessionStorage.removeItem('foundry.pending-request'); } catch(_) {} }
  function clearPendingRequest() { S.pendingRequest='';S.pendingReceipt=null;persistRequest(); }
  try { const saved=sessionStorage.getItem('foundry.pending-request')||'';S.pendingRequest=/^[A-Za-z0-9_-]{1,80}$/.test(saved)?saved:'';persistRequest(); } catch(_) {}
  let pollBusy=false;
  async function refreshStatus(silent=false) {
    if(pollBusy)return;pollBusy=true;
    try {
      const job=await api('/api/status',undefined,12000);S.job=job;
      if(S.pendingRequest&&job.request_id===S.pendingRequest){clearPendingRequest();S.submitting=false;notice('已找到本次部署任务，继续读取执行状态。');}
      if(S.pendingRequest && job.request_id!==S.pendingRequest){
        const requestId=S.pendingRequest;
        const receipt=await api('/api/submission-status/'+encodeURIComponent(requestId),undefined,12000);
        // 查询期间提交状态可能已更新，旧响应不能重新锁住已找到的任务。
        if(S.pendingRequest===requestId) {
          S.pendingReceipt=receipt;
          if(receipt.status==='rejected'){clearPendingRequest();S.submitting=false;S.checked=-1;notice('本次提交未执行：'+receipt.message+'。修正后请重新确认。',true);}
          else if(receipt.status==='resolved'){clearPendingRequest();S.submitting=false;S.checked=-1;notice('已结束上次提交的本地等待；不会再次执行原请求。云端结果仍以你核实的实际状态为准。');}
        }
      }
      renderJob();
    } catch(error) {
      if(!silent)throw error;
      if(['running','recovery_required'].includes(S.job?.status)||S.pendingRequest) $('jobMessage').textContent='与本地服务暂时失联，结果未知；请恢复服务后刷新，不要重复部署。';
    } finally {persistRequest();pollBusy=false;updateLocks();}
  }
  async function resolvePendingSubmission() {
    const requestId=S.pendingRequest;
    if(!requestId||S.submitting)return;
    if(!confirm('请先核实 Azure 和原部署进程，确认没有仍在进行的操作。结束本地等待不代表部署失败，不会取消云端请求或自动重试；原请求会被永久标记为不可重新提交。确认已核实？'))return;
    const receipt=await api('/api/resolve-submission',{request_id:requestId,confirmed:true});
    if(S.pendingRequest===requestId && receipt.status==='resolved') {
      clearPendingRequest();S.checked=-1;notice('已结束本地等待。请按 Azure 实际状态调整计划后再部署。');
    }
    await refreshStatus();renderJob();
  }
  async function deployPlan() {
    if(locked())return;
    if(!S.credentials)throw Error('请先连接 SP');
    const errors=planErrors();if(errors.length)throw Error(errors.join('\n'));
    // 先锁定表单再等待预览，确认和执行使用同一份快照。
    S.submitting=true;updateLocks();
    try {
      const frozen=JSON.parse(JSON.stringify({...P.payload(S.targets,S.tasks),options:options()}));
      const epoch=S.epoch;
      const preview=await api('/api/preview-plan',frozen);
      if(epoch!==S.epoch)throw Error('登录身份已改变，请重新确认');
      S.preview=preview;renderPreview();
      const count=preview.deployments.length;
      const regions=new Set(preview.deployments.map(r=>r.location)).size;
      if(!confirm('确认在 '+regions+' 个区域执行 '+count+' 个模型部署实例？将按预览中的名称执行，可能产生费用。'))return;
      const payload={...frozen,plan_hash:preview.plan_hash,request_id:P.uid('request')};
      S.submitted=payload;S.pendingRequest=payload.request_id;S.pendingReceipt={status:'checking'};persistRequest();renderJob();
      try {
        S.job=await api('/api/deploy',withCredentials(payload));clearPendingRequest();S.checked=-1;
        notice('已提交部署，正在读取真实执行状态。');renderJob();
      } catch(error) {
        if(error.definitive){clearPendingRequest();await refreshStatus(true);renderJob();}
        else{S.pendingReceipt=null;notice('提交结果暂未确认，正在查询本地记录。不要重复提交。',true);await refreshStatus(true);renderJob();}
        throw error;
      }
    } finally {persistRequest();S.submitting=false;updateLocks();}
  }
  function retryFailed() {
    const entries=(S.job?.entries||[]).filter(e=>['failed','auth_failed','config_failed','not_run'].includes(e.status));
    if(!entries.length)return;
    if(!S.credentials)throw Error('请重新连接 SP 后重试');
    const targets=[],tasks=[],map=new Map();
    for(const e of entries){const r=e.row,key=[r.subscription_id,r.resource_group,r.account_name,r.project_name].join('|');
      if(!map.has(key)){const t=P.newTarget(r.subscription_id);Object.assign(t,{location:r.location,resource_group:r.resource_group,group_mode:r.resource_group_mode||'new',account_name:r.account_name,account_mode:r.account_mode||'new',project_name:r.project_name,project_mode:r.project_mode||'new'});targets.push(t);map.set(key,t);}
      tasks.push({id:e.id,target_id:map.get(key).id,model_name:r.model_name,model_format:r.model_format,model_version:r.model_version,sku_name:r.sku_name,capacity:String(r.capacity),deployment_name:r.deployment_name,rai_policy_name:r.rai_policy_name||'',sequence:++S.sequence});}
    S.targets=targets;S.tasks=tasks;S.mode='custom';dirty();setPage(4);notice('仅保留 '+tasks.length+' 条失败 / 未执行任务。已成功和状态未确认的任务不会自动重试；核对计划后再次确认部署。');
    return loadCatalogs(true);
  }
  function renderManagerGroups() {
    const id=$('managerSub').value,entry=S.resources[id];
    $('managerGroups').innerHTML=entry?.status==='loading'?'<div class="empty">'+spinner+'读取中…</div>':entry?.status==='error'?'<div class="notice error">'+esc(entry.error)+'</div>':entry?.status==='ready'?(entry.data.resource_groups.map(g=>'<div class="manager-row"><span><b>'+esc(g.name)+'</b><br><small class="hint">'+esc(g.location)+'</small></span><button class="danger" data-delete-group="'+esc(g.name)+'">预览删除</button></div>').join('')||'<div class="empty">没有可读取的资源组。</div>'):'<div class="empty">选择订阅后读取资源组。</div>';
  }
  let connectedIdentity = '';
  function clearCustomerPlan() {
    S.targets=[];S.tasks=[];S.bulkSubscription='';S.submitted=null;S.sequence=0;nextNamingSequence=0;
    S.naming={prefix:'',base:'',start:'1',padding:'1',suffix:''};
    document.querySelectorAll('[data-naming]').forEach(el=>el.value=S.naming[el.dataset.naming]||'');
    S.deletePreview=null;$('deletePreview').hidden=true;dirty();renderTargets();renderModels();renderNamingTargets();
  }
  function clearAuth() {S.epoch++;S.credentials=null;S.resources={};S.projects={};S.catalogs={};S.subscriptions=[];S.checked=-1;S.deletePreview=null;for(const id of ['spPaste','clientId','clientSecret','tenantId'])$(id).value='';$('connectionBadge').textContent='尚未连接';$('connectionBadge').className='badge';$('authResult').textContent='等待连接';dirty();updateLocks();}
  function parseInputs(){const parsed=P.parseSP($('spPaste').value);$('clientId').value=parsed.AZURE_CLIENT_ID;$('clientSecret').value=parsed.AZURE_CLIENT_SECRET;$('tenantId').value=parsed.AZURE_TENANT_ID;$('spPaste').value='';$('parseInfo').textContent='已识别三项凭据，密码已隐藏。';}
  // Event delegation keeps target/task identity stable through list re-rendering.
  document.querySelectorAll('[data-page],[data-go]').forEach(b=>b.addEventListener('click',()=>setPage(+(b.dataset.page||b.dataset.go))));
  $('parseSP').onclick=()=>busy($('parseSP'),'识别中',async()=>parseInputs());
  $('clearSP').onclick=()=>{if(S.tasks.length&&!confirm('清除凭据并清空当前客户的草稿？已部署资源和结果不会删除。'))return;clearAuth();connectedIdentity='';clearCustomerPlan();setPage(1);notice('凭据、查询缓存和当前草稿已清除。');};
  $('connect').onclick=()=>busy($('connect'),'连接并读取订阅…',async()=>{
    if($('spPaste').value.trim())parseInputs();
    const credentials={AZURE_CLIENT_ID:$('clientId').value.trim(),AZURE_CLIENT_SECRET:$('clientSecret').value || (S.credentials?.AZURE_CLIENT_ID===$('clientId').value.trim() && S.credentials?.AZURE_TENANT_ID===$('tenantId').value.trim()?S.credentials.AZURE_CLIENT_SECRET:''),AZURE_TENANT_ID:$('tenantId').value.trim()};
    const identity=(credentials.AZURE_TENANT_ID+'|'+credentials.AZURE_CLIENT_ID).toLowerCase();
    if(connectedIdentity&&connectedIdentity!==identity){if(!confirm('切换客户身份会清空当前部署草稿，避免误用上一客户的订阅和名称。继续？'))return;clearCustomerPlan();}
    connectedIdentity=identity;
    const epoch=++S.epoch;$('connectionBadge').textContent='正在连接…';$('connectionBadge').className='badge';$('authResult').textContent='正在读取订阅';S.credentials=null;S.resources={};S.projects={};S.catalogs={};S.subscriptions=[];dirty();
    try {
      const data=await api('/api/list-subscriptions',{credentials});if(epoch!==S.epoch)return;
      if(!Array.isArray(data.subscriptions))throw Error('订阅列表响应无效，请重启本地服务后重试。');
      S.subscriptions=data.subscriptions.filter(s=>!s.state||s.state.toLowerCase()==='enabled');
      if(!S.subscriptions.length)throw Error('SP 已连接，但没有返回可用订阅，请核对授权范围。');
    } catch(error) {
      if(epoch!==S.epoch)return;
      $('connectionBadge').textContent='连接未完成';$('connectionBadge').className='badge';
      $('authResult').textContent=error.message;
      // Keep the secret in the masked input for retry, not in persistent storage.
      $('clientSecret').value=credentials.AZURE_CLIENT_SECRET;
      throw error;
    }
    S.credentials=credentials;if(!S.bulkSubscription&&S.subscriptions.length===1)S.bulkSubscription=S.subscriptions[0].subscription_id;for(const t of S.targets)if(!t.subscription_id&&S.subscriptions.length===1)t.subscription_id=S.subscriptions[0].subscription_id;
    $('connectionBadge').textContent='已连接 · '+S.subscriptions.length+' 个订阅';$('connectionBadge').className='badge success';$('authResult').textContent='已读取 '+S.subscriptions.length+' 个可用订阅';$('clientSecret').value='';$('manualCredentials').open=false;notice('连接成功，请选择订阅和区域。');setPage(2);
  });
  ['spPaste','clientId','clientSecret','tenantId'].forEach(id=>$(id).addEventListener('input',()=>{if(S.credentials){S.credentials=null;S.epoch++;S.resources={};S.projects={};S.catalogs={};dirty();$('connectionBadge').textContent='凭据已修改，请重新连接';$('connectionBadge').className='badge';updateLocks();}}));
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{
    if(locked())return;
    if(b.dataset.mode==='standard'&&!P.canStandard(S.targets,S.tasks)){notice('标准模式支持同一订阅中每个区域一个目标。当前计划包含跨订阅、同区域多目标或自定义模型名称，请继续使用自定义模式；已有配置不会删除。',true);return;}
    S.mode=b.dataset.mode;renderTargets();renderModels();notice('');
  });
  document.querySelector('.deployment-mode-tabs').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||locked())return;
    event.preventDefault();
    const tabs=[...document.querySelectorAll('.deployment-mode-tabs [data-mode]')];
    const current=tabs.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?1:(current+1)%tabs.length;
    tabs[next].click();
    tabs.find(tab=>tab.getAttribute('aria-selected')==='true')?.focus();
  });
  $('regionSearch').oninput=renderRegionChoices;
  $('regionChoices').onchange=event=>{if(event.target.dataset.region)changeRegion(event.target.dataset.region,event.target.checked);};
  $('selectedRegions').onclick=event=>{const b=event.target.closest('[data-remove-region]');if(b)changeRegion(b.dataset.removeRegion,false);};
  $('bulkSubscription').onchange=event=>{
    if(locked())return;
    const next=event.target.value;if(next===S.bulkSubscription)return;
    if(S.tasks.length||S.targets.some(t=>t.group_mode==='existing')){notice('当前计划已选择模型或已有资源组。请先移除任务并改为新建资源组，或在自定义模式添加其它订阅；系统不会迁移已有配置。',true);renderBulkRegions();return;}
    if(S.targets.some(t=>t.subscription_id)&&!confirm('切换订阅后，所选区域将用于新订阅。继续？')){renderBulkRegions();return;}
    S.bulkSubscription=next;for(const t of S.targets){t.subscription_id=next;t.drafts={};}
    dirty();renderTargets();renderModels();notice('');
  };
  $('batchNaming').addEventListener('input',event=>{
    const key=event.target.dataset.naming;if(!key||locked())return;
    S.naming[key]=event.target.value;refreshNaming();dirty();
  });
  $('addTarget').onclick=()=>{if(locked())return;if(S.targets.length>=20){notice('最多 20 个部署目标',true);return;}const target=P.newTarget(S.targets[0]?.subscription_id||S.bulkSubscription);namingState(target);S.targets.push(target);dirty();renderTargets();};
  document.addEventListener('click',event=>{
    const b=event.target.closest('button'),card=event.target.closest('#targets [data-target],#namingTargets [data-target]');if(!b||!card||locked())return;const t=S.targets.find(t=>t.id===card.dataset.target);if(!t)return;
    if(b.dataset.source){switchSource(t,b.dataset.source,b.dataset.value);return;}
    if(b.dataset.action==='resources')busy(b,'读取中…',()=>loadResources(t.subscription_id,true));
    if(b.dataset.action==='projects')busy(b,'读取中…',()=>loadProjects(t,true));
    if(b.dataset.action==='remove-target'){
      const count=S.tasks.filter(task=>task.target_id===t.id).length;
      if(count&&!confirm('移除此目标会从本次计划移除 '+count+' 条模型任务，不会删除 Azure 资源。继续？'))return;
      S.tasks=S.tasks.filter(task=>task.target_id!==t.id);
      S.targets=S.targets.filter(x=>x!==t);dirty();renderTargets();renderModels();renderNamingTargets();notice('已从部署计划移除目标，Azure 资源未删除。');
    }
    if(b.dataset.action==='reset-names'){
      if(t.group_mode==='new'&&(!P.groupNamePart(S.naming.base)||!namingNumber(t))){notice('请先填写业务名称和有效起始编号',true);return;}
      const n=namingState(t);
      for(const [field,mode] of [['resource_group','group_mode'],['account_name','account_mode'],['project_name','project_mode']])if(t[mode]==='new'){delete n.manual[field];t[field]='';delete n.auto[field];}
      syncNaming(t);dirty();renderTargets();renderNamingTargets();
    }
  });
  document.addEventListener('input',event=>{
    const el=event.target,card=el.closest('#targets [data-target],#namingTargets [data-target]');
    if(!card||!el.dataset.field||el.tagName==='SELECT'||locked())return;
    const t=S.targets.find(t=>t.id===card.dataset.target),key=el.dataset.field;if(!t)return;
    if(key==='location')return; // 区域代码在完成输入后统一确认，不能逐字符迁移已选模型。
    if(key==='naming.sequence') {
      const n=namingState(t),value=Number(el.value);
      n.sequenceDraft=el.value;n.sequenceError=!Number.isInteger(value)||value<1||value>999999;
      if(!n.sequenceError)n.sequence=value;
      refreshNaming();dirty();return;
    }
    t[key]=el.value.trim();
    if(['resource_group','account_name','project_name'].includes(key))namingState(t).manual[key]=true;
    refreshNaming();dirty();
  });
  document.addEventListener('change',event=>{
    const el=event.target,card=el.closest('#targets [data-target],#namingTargets [data-target]');
    if(!card||!el.dataset.field||locked())return;
    const t=S.targets.find(t=>t.id===card.dataset.target),key=el.dataset.field;if(!t)return;
    if(el.tagName!=='SELECT'&&key!=='location')return;
    const value=key==='location'?el.value.trim().toLowerCase().replace(/\s+/g,''):el.value;
    if(key==='location'&&!/^[a-z0-9]+$/.test(value)){notice('请输入有效的英文区域代码',true);el.value=t.location;return;}
    if(!changeTargetField(t,key,value))el.value=t[key];
  });
  $('toNaming').onclick=()=>{if(locked())return;const errors=catalogErrors();if(errors.length){notice(errors.join('\n'),true);return;}notice('');setPage(3);};
  $('toModels').onclick=()=>busy($('toModels'),'读取模型…',async()=>{const errors=[...catalogErrors(),...namingErrors(),...P.validateTargets(S.targets)];if(errors.length)throw Error(errors.join('\n'));notice('');setPage(4);await loadCatalogs();});
  $('loadModels').onclick=()=>busy($('loadModels'),'读取模型…',()=>loadCatalogs(true));
  for(const id of ['modelSearch','catalogTarget','publisherFilter','coverageFilter'])$(id).addEventListener(id==='modelSearch'?'input':'change',()=>{S.modelLimit=36;renderCatalog();});
  $('catalogPager').onclick=()=>{S.modelLimit+=36;renderCatalog();};
  $('catalog').addEventListener('click',event=>{
    const b=event.target.closest('[data-all-model]');if(!b||locked())return;
    const model=allModels().find(m=>P.modelKey(m)===b.dataset.allModel);if(!model)return;
    try{addModelTargets(model,S.targets.filter(t=>supportedVariants(model,t).length));dirty();renderCatalog();renderTasks();notice('');}catch(error){notice(error.message,true);}
  });
  $('catalog').addEventListener('change',event=>{
    const input=event.target,key=input.dataset.modelTarget,targetId=input.dataset.targetId;
    if(!key||!targetId||locked())return;
    const model=allModels().find(m=>P.modelKey(m)===key),target=S.targets.find(t=>t.id===targetId);
    if(!model||!target){renderCatalog();return;}
    const matching=t=>t.target_id===targetId&&P.modelKey({name:t.model_name,format:t.model_format})===key;
    try {
      if(input.checked){
        // 只新增用户明确勾选的模型—目标组合，保留其他组合的自定义参数。
        if(!S.tasks.some(matching)){
          addModelTargets(model,[target]);
        }
      } else {
        const count=S.tasks.filter(matching).length;
        if(count>1&&!confirm('此模型在该目标有 '+count+' 条任务，取消选择将全部移除，是否继续？')){renderCatalog();return;}
        S.tasks=S.tasks.filter(t=>!matching(t));
      }
      dirty();renderCatalog();renderTasks();
    } catch(error){notice(error.message,true);renderCatalog();}
  });
  $('tasks').addEventListener('click',event=>{const b=event.target.closest('[data-task-action]'),card=event.target.closest('[data-task]');if(!b||!card||locked())return;const t=S.tasks.find(t=>t.id===card.dataset.task);
    if(b.dataset.taskAction==='remove')S.tasks=S.tasks.filter(x=>x!==t);
    dirty();renderCatalog();renderTasks();
  });
  $('tasks').addEventListener('change',event=>{const el=event.target,card=el.closest('[data-task]');if(!card||!el.dataset.field||locked())return;const task=S.tasks.find(t=>t.id===card.dataset.task),key=el.dataset.field;
    if(key==='target_id')reassign(task,el.value);
    else if(key==='guard')task.rai_policy_name=el.checked?'foundry-console-guard-low-v1':'foundry-console-guard-high-v1';
    else {task[key]=el.value.trim();if(key==='model_version'||key==='sku_name'){const target=S.targets.find(t=>t.id===task.target_id),model=P.variants({name:task.model_name,format:task.model_format},target,S.catalogs).find(m=>m.version===task.model_version);const sku=model?.skus.find(s=>s.name===task.sku_name)||P.skuFor(model);if(sku){task.sku_name=sku.name;task.capacity=String(sku.minimum||1);}}}
    dirty();renderCatalog();renderTasks();
  });
  $('toConfirm').onclick=()=>busy($('toConfirm'),'生成确认计划…',async()=>{await previewPlan();notice('');setPage(5);});
  $('checkPlan').onclick=()=>busy($('checkPlan'),'正在只读预检…',async()=>{await previewPlan(true);notice('目标预检通过。请核对上方名称和任务数后开始部署。');});
  $('deploy').onclick=()=>busy($('deploy'),'正在提交…',deployPlan);
  ['registerProvider','updateExisting','skipQuota','concurrency'].forEach(id=>$(id).onchange=dirty);
  $('refreshStatus').onclick=()=>busy($('refreshStatus'),'刷新中…',()=>refreshStatus());
  $('retryFailed').onclick=()=>busy($('retryFailed'),'准备失败任务…',retryFailed);
  $('resolveSubmission').onclick=()=>busy($('resolveSubmission'),'确认中…',resolvePendingSubmission);
  $('resourceManager').onclick=()=>{$('managerSub').innerHTML=subscriptionOptions(S.targets[0]?.subscription_id||'');$('deletePreview').hidden=true;renderManagerGroups();$('resourceDialog').showModal();};
  $('acknowledgeRecovery').onclick=()=>busy($('acknowledgeRecovery'),'确认中…',async()=>{
    if(!confirm('我已在 Azure 核实上次任务，确认没有仍在进行的部署操作。解除锁定不会取消云端请求，也不会自动重试待核实项。继续？'))return;
    S.job=await api('/api/acknowledge-recovery',{job_id:S.job.id,confirmed:true});renderJob();
  });
  $('closeResources').onclick=()=>$('resourceDialog').close();
  $('managerSub').onchange=()=>{S.deletePreview=null;$('deletePreview').hidden=true;renderManagerGroups();};
  $('managerLoad').onclick=()=>busy($('managerLoad'),'读取中…',()=>loadResources($('managerSub').value,true));
  $('managerGroups').onclick=event=>{const b=event.target.closest('[data-delete-group]');if(!b||locked())return;busy(b,'预览中…',async()=>{
    const epoch=S.epoch,subscription=$('managerSub').value;const data=await api('/api/preview-delete-group',withCredentials({subscription_id:subscription,resource_group:b.dataset.deleteGroup}));if(epoch!==S.epoch||subscription!==$('managerSub').value)return;
    S.deletePreview=data;$('deletePreview').hidden=false;$('deletePreview').innerHTML='<div class="notice error">删除 '+esc(data.resource_group)+' 将删除其中全部 '+data.resource_count+' 个资源，不可由本工具撤销。</div><pre>'+esc(JSON.stringify(data.resources,null,2))+'</pre><label class="field">输入完整资源组名称确认<input id="deleteName" autocomplete="off"></label><div class="toolbar"><button id="confirmDelete" class="danger">确认删除资源组</button></div>';
  });};
  $('deletePreview').onclick=event=>{if(event.target.id!=='confirmDelete'||locked()||!S.deletePreview)return;busy(event.target,'提交删除…',async()=>{
    const data=S.deletePreview,confirmation=$('deleteName').value;if(confirmation!==data.resource_group)throw Error('请输入完全一致的资源组名称');
    if(!confirm('最后确认：永久删除资源组 '+data.resource_group+' 及全部资源？'))return;
    const result=await api('/api/delete-group',withCredentials({subscription_id:data.subscription_id,resource_group:data.resource_group,confirmation,confirmation_token:data.confirmation_token}));S.deletePreview=null;$('deletePreview').hidden=true;dirty();notice(result.message);await loadResources(data.subscription_id,true);
  });};
  window.addEventListener('beforeunload',event=>{if(locked()){event.preventDefault();event.returnValue='';}});
  if(location.protocol==='file:'){$('fileWarning').hidden=false;$('connect').disabled=true;}else{api('/api/version').then(data=>{$('version').textContent=data.version; if(data.version!=='2026.10.10-customer-v3')notice('本地服务版本与页面不一致，请关闭旧窗口后重新运行部署.cmd。',true);}).catch(()=>notice('无法连接本地服务，请重新运行部署.cmd。',true));refreshStatus(true).then(()=>{if(S.pendingRequest||S.job&&S.job.status!=='idle')setPage(5);});setInterval(()=>{if(['running','recovery_required'].includes(S.job?.status)||S.pendingRequest)refreshStatus(true);},2000);}
  renderTargets();renderModels();updateLocks();
})();
