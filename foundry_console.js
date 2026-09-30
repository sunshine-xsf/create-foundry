/* Local console controller. Credentials stay in memory, never localStorage. */
'use strict';
(() => {
  const P = window.FoundryPlan;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const opt = (value, label, selected) => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  const spinner = '<span class="spinner" aria-hidden="true"></span>';
  const S = {page: 1, mode: 'standard', credentials: null, epoch: 0, subscriptions: [], targets: [P.newTarget()], tasks: [],
    resources: {}, projects: {}, catalogs: {}, revision: 0, checked: -1, preview: null, observations: [],
    job: null, submitting: false, sequence: 0, modelLimit: 36, submitted: null, pendingRequest: '', deletePreview: null};
  const regions = {eastus:'美国东部',eastus2:'美国东部 2',westus:'美国西部',westus2:'美国西部 2',westus3:'美国西部 3',southcentralus:'美国中南部',northcentralus:'美国中北部',centralus:'美国中部',westcentralus:'美国中西部',canadacentral:'加拿大中部',canadaeast:'加拿大东部',brazilsouth:'巴西南部',mexicocentral:'墨西哥中部',swedencentral:'瑞典中部',westeurope:'西欧',northeurope:'北欧',uksouth:'英国南部',ukwest:'英国西部',francecentral:'法国中部',germanywestcentral:'德国中西部',switzerlandnorth:'瑞士北部',norwayeast:'挪威东部',polandcentral:'波兰中部',italynorth:'意大利北部',spaincentral:'西班牙中部',australiaeast:'澳大利亚东部',australiasoutheast:'澳大利亚东南部',newzealandnorth:'新西兰北部',japaneast:'日本东部',japanwest:'日本西部',koreacentral:'韩国中部',southeastasia:'东南亚',eastasia:'东亚',centralindia:'印度中部',southindia:'印度南部',indonesiacentral:'印度尼西亚中部',malaysiawest:'马来西亚西部',uaenorth:'阿联酋北部',qatarcentral:'卡塔尔中部',israelcentral:'以色列中部',southafricanorth:'南非北部'};
  const locked = () => S.submitting || S.job?.status === 'running' || !!S.pendingRequest;
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
      if (!response.ok || data.ok === false) { const error = Error(data.message || '请求失败（' + response.status + '）'); error.definitive = true; throw error; }
      return data;
    } catch (error) { if (error.name === 'AbortError') throw Error('读取超时。部署请求可能仍在处理，请先刷新状态，不要重复提交。'); throw error; }
    finally { clearTimeout(timer); }
  }
  function withCredentials(data = {}) { if (!S.credentials) throw Error('请先连接 SP'); return {...data, credentials: {...S.credentials}}; }
  // 手动只读预检是辅助步骤；提交按钮依据当前计划完整性启用，后端仍复查目标。
  function planErrors() { return [...P.validateTargets(S.targets), ...P.validateTasks(S.targets,S.tasks,S.catalogs)]; }
  function dirty() { S.revision++; S.checked = -1; S.preview = null; S.observations = []; $('preflight').textContent = '计划已更新，可直接部署，也可先执行只读预检。'; updateLocks(); }
  function updateLocks() {
    const isLocked = locked();
    for (const container of ['page1','page2','page3','confirmation']) {
      $(container).querySelectorAll('input,select,textarea,button').forEach(el => { if (isLocked) { if (!el.disabled) el.dataset.locked = '1'; el.disabled = true; } else if (el.dataset.locked) { delete el.dataset.locked; el.disabled = false; } });
    }
    document.querySelectorAll('[data-mode]').forEach(el => el.disabled = isLocked);
    $('deploy').disabled = isLocked || !!$('deploy').dataset.busy || !!$('checkPlan').dataset.busy || location.protocol === 'file:' || !S.credentials || planErrors().length > 0;
    $('retryFailed').disabled = isLocked;
    $('resourceManager').disabled = isLocked || !S.credentials;
  }
  function setPage(page) {
    if (page > 1 && !S.credentials && !(page === 4 && S.job && S.job.status !== 'idle')) { notice('请先连接 Azure，读取订阅。', true); return; }
    S.page = page; document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page' + page));
    document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', +el.dataset.page === page); el.setAttribute('aria-current', +el.dataset.page === page ? 'step' : 'false'); });
    if (page === 2) renderTargets();
    if (page === 3) renderModels();
    if (page === 4) { renderPreview(); renderJob(); }
    updateLocks(); window.scrollTo({top:0,behavior:'smooth'});
  }
  function subscriptionLabel(id) { const sub = S.subscriptions.find(s => s.subscription_id === id); return sub?.display_name || id || '未选订阅'; }
  function targetLabel(t) { return (t.label || '目标 ' + (S.targets.indexOf(t) + 1)) + ' · ' + t.location; }
  function subscriptionOptions(selected) {
    let html = opt('', '请选择订阅', selected);
    for (const sub of S.subscriptions) html += opt(sub.subscription_id, sub.display_name + ' · ' + sub.subscription_id.slice(0,8) + '…', selected);
    if (selected && !S.subscriptions.some(s => s.subscription_id === selected)) html += opt(selected, selected, selected);
    return html;
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
  function renderTargets() {
    $('addTarget').hidden = S.mode !== 'custom';
    $('modeDescription').textContent = S.mode === 'standard' ? '一个目标，可新建或使用已有资源组；自动创建 Foundry。' : '多个目标独立设置，支持已有 Foundry 和 Project。';
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
      const naming = t.naming;
      return '<article class="target-card" data-target="' + t.id + '"><div class="target-header"><h3><span class="number">' + String(i+1).padStart(2,'0') + '</span>' + esc(t.label || '部署目标 ' + (i+1)) + '</h3><div class="toolbar"><button class="quiet" data-action="resources">刷新已有资源</button>' + (S.targets.length > 1 ? '<button class="quiet" data-action="remove-target">移除目标</button>' : '') + '</div></div><div class="target-body">' +
        '<div class="grid2">' + selectField('Azure 订阅','subscription_id',t.subscription_id,subscriptionOptions(t.subscription_id)) + selectField('部署区域','location',t.location,regionOptions,t.account_mode === 'existing' && !!t.account_name) + '</div>' +
        (S.mode === 'custom' ? '<details><summary>目标备注 / 其它区域</summary><div class="grid2">' + inputField('目标备注','label',t.label,'例如：客户 A · 主区域') + inputField('区域代码','location',t.location,'例如 eastus',t.account_mode === 'existing' && !!t.account_name) + '</div></details>' : '') +
        '<div class="target-section"><h3>资源组</h3>' + segment(t,'group_mode',['新建资源组','使用已有资源组']) +
        (t.group_mode === 'new' ? inputField('资源组名称 *','resource_group',t.resource_group,'例如 rg-customer-eastus') : resourceState(t) + selectField('已有资源组 *','resource_group',t.resource_group,groupOptions,r?.status === 'loading')) + '</div>' +
        '<div class="target-section"><div class="grid2"><div><h3>Foundry 资源</h3>' + (S.mode === 'custom' && t.group_mode === 'existing' ? segment(t,'account_mode',['新建 Foundry','使用已有 Foundry']) : '<p class="hint">自动创建；同名兼容资源会在预检中提示复用。</p>') +
        (t.account_mode === 'existing' ? selectField('已有 Foundry *','account_name',t.account_name,accountOptions,r?.status === 'loading') + '<p class="hint selection-note">区域跟随所选 Foundry。</p>' : (S.mode === 'custom' ? inputField('Foundry 名称（可自动）','account_name',t.account_name,P.accountName(t)) : '<div class="name-preview"><code>' + esc(P.accountName(t)) + '</code></div>')) + '</div><div><h3>Project 项目</h3>' +
        (S.mode === 'custom' && t.account_mode === 'existing' ? segment(t,'project_mode',['新建 Project','使用已有 Project']) : '<p class="hint">项目名称独立于模型部署名称。</p>') +
        (t.project_mode === 'existing' ? selectField('已有 Project *','project_name',t.project_name,projectOptions,projects?.status === 'loading') + '<button class="quiet" data-action="projects">' + (projects?.status === 'loading' ? spinner : '') + '刷新 Project</button>' + (projects?.status === 'error' ? '<p class="hint error">' + esc(projects.error) + '</p>' : projects?.status === 'ready' && !names.length ? '<p class="hint">没有 Project，可以切换到新建。</p>' : '') : inputField('Project 名称 *','project_name',t.project_name,'例如 customer-project')) + '</div></div></div>' +
        ((t.group_mode === 'new' || t.project_mode === 'new') ? '<details><summary>拼接资源组 / Project 名称</summary><div class="name-builder"><div class="grid3">' + inputField('前缀','naming.prefix',naming.prefix,'客户简称') + inputField('主体','naming.base',naming.base,'业务名称') + inputField('后缀','naming.suffix',naming.suffix,'prod') + '</div><div class="toolbar"><label class="hint"><input type="checkbox" data-field="naming.region"' + (naming.region ? ' checked' : '') + '> 加上区域</label><label class="inline-field hint">编号<input data-field="naming.number" value="' + esc(naming.number) + '" style="width:80px"></label><button class="secondary" data-action="apply-names">生成并填入名称</button></div><div class="hint" data-name-sample>' + esc(nameSample(t)) + '</div></div></details>' : '') +
        '<div class="name-preview"><div><span>资源组</span><code data-preview-group>' + esc(t.resource_group || '待设置') + '</code></div><div><span>Foundry</span><code data-preview-account>' + esc(P.accountName(t) || '待选择') + '</code></div><div><span>Project</span><code data-preview-project>' + esc(t.project_name || '待设置') + '</code></div></div></div></article>';
    }).join(''); updateLocks();
  }
  function nameSample(t) { const n=t.naming; return P.joinName(n.prefix,n.base,n.region ? t.location : '',n.number,n.suffix) || '填写主体后生成名称'; }
  function switchSource(t, key, value) {
    const field = {group_mode:'resource_group',account_mode:'account_name',project_mode:'project_name'}[key];
    t.drafts[key + ':' + t[key]] = t[field]; t[key] = value; t[field] = t.drafts[key + ':' + value] || '';
    if (key === 'group_mode') { delete t.drafts['account_mode:existing']; delete t.drafts['project_mode:existing']; t.account_mode='new'; t.account_name=''; if (t.project_mode === 'existing') t.project_name=t.drafts['project_mode:new']||''; t.project_mode='new'; }
    if (key === 'account_mode') { delete t.drafts['project_mode:existing']; if (t.project_mode === 'existing') t.project_name=t.drafts['project_mode:new']||''; t.project_mode='new'; }
    dirty(); renderTargets();
    if (key === 'group_mode' && value === 'existing' && S.resources[t.subscription_id]?.status !== 'ready') loadResources(t.subscription_id);
    if (key === 'project_mode' && value === 'existing') loadProjects(t);
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
    const filtered=items.filter(m=>(!search||(m.name+' '+m.format).toLowerCase().includes(search))&&(!target||m.targets.includes(target))&&(!publisher||m.format===publisher));
    $('catalogCount').textContent='当前 ' + filtered.length + ' 个模型 · 已选 ' + S.tasks.length + ' 条任务';
    $('catalog').innerHTML=filtered.length?filtered.slice(0,S.modelLimit).map(m=>{
      const key=P.modelKey(m),selected=S.tasks.some(t=>P.modelKey({name:t.model_name,format:t.model_format})===key);
      return '<label class="model-card'+(selected?' selected':'')+'"><input type="checkbox" data-model="'+esc(key)+'"'+(selected?' checked':'')+'><span><strong>'+esc(m.name)+'</strong><small>'+esc(m.format)+' · '+m.targets.length+' 个目标可选<br>'+esc(m.targets.map(id=>targetLabel(S.targets.find(t=>t.id===id))).join(' / '))+'</small></span></label>';
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
    const errors=P.validateTargets(S.targets); if(errors.length) throw Error(errors.join('\n'));
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
      const options=S.targets.map(t=>opt(t.id,targetLabel(t),task.target_id)).join('');
      const versions=Array.from(new Set(variants.map(v=>v.version)));
      const versionOptions=preserveOption(versions.map(v=>opt(v,v,task.model_version)).join(''),task.model_version,versions);
      const skuOptions=preserveOption(skus.map(s=>opt(s.name,s.name,task.sku_name)).join(''),task.sku_name,skus.map(s=>s.name));
      return '<article class="task" data-task="'+task.id+'"><div class="task-top"><div class="task-title"><strong>'+String(i+1).padStart(2,'0')+' · '+esc(task.model_name)+'</strong><small>'+esc(task.model_format)+' · '+esc(task.model_version)+' · '+esc(task.sku_name)+' · capacity '+esc(task.capacity)+'</small></div>'+selectField('部署目标','target_id',task.target_id,options,S.mode==='standard')+'<div class="toolbar">'+(S.mode==='custom'?'<button class="quiet" data-task-action="copy">复制</button>':'')+'<button class="quiet" data-task-action="remove">移除</button></div></div>'+
        (!model||!skus.some(s=>s.name===task.sku_name)?'<p class="hint error">此任务的版本或 SKU 未通过当前目标目录校验，请刷新目录或重新选择。</p>':'')+
        (S.mode==='custom'?'<details><summary>版本、容量与模型部署名称</summary><div class="task-options">'+selectField('版本','model_version',task.model_version,versionOptions)+selectField('SKU','sku_name',task.sku_name,skuOptions)+inputField('容量（capacity）','capacity',task.capacity)+inputField('部署名称（留空使用模型名称）','deployment_name',task.deployment_name,target?P.deploymentName({...task,deployment_name:''},target):'')+'</div></details>':'')+
        '<div class="name-preview"><div><span>预计模型部署名称</span><code>'+esc(target?P.deploymentName(task,target):'请重新选择目标')+'</code></div></div>'+
        (task.model_format.toLowerCase()==='openai'?'<label class="guard-control"><input type="checkbox" data-field="guard"'+(task.rai_policy_name==='foundry-console-guard-low-v1'?' checked':'')+'> 内容防护 <span class="hint">打开：低阈值拦截；关闭：仅高风险阈值，不代表关闭 Azure 审核。</span></label>':'<p class="hint">该模型使用平台 / 提供方支持的默认内容安全设置。</p>')+'</article>';
    }).join(''):'<div class="empty">在上方勾选模型，即可添加部署任务。</div>'; updateLocks();
  }
  function reassign(task, targetId) {
    task.target_id=targetId; const target=S.targets.find(t=>t.id===targetId);
    const variants=P.variants({name:task.model_name,format:task.model_format},target,S.catalogs);
    if(!variants.length) { notice('该目标目录未包含此模型。请重新读取或选择其它目标。',true); return; }
    const model=variants.find(m=>m.version===task.model_version)||P.preferred(variants),sku=model.skus.find(s=>s.name===task.sku_name)||P.skuFor(model);
    task.model_version=model.version;task.sku_name=sku.name; task.capacity=String(sku.minimum||1);
  }
  function options() { return {register_provider:$('registerProvider').checked,update_existing:$('updateExisting').checked,skip_quota_check:$('skipQuota').checked,max_concurrency:Number($('concurrency').value)}; }
  function renderPreview() {
    $('planCount').textContent=S.tasks.length+' 条任务';
    const rows=S.preview?.deployments || S.tasks.map(task=>{const target=S.targets.find(t=>t.id===task.target_id);return target?{...P.targetPayload(target),...P.taskPayload(task,S.targets)}:null;}).filter(Boolean);
    $('planPreview').innerHTML=rows.length?'<table><thead><tr><th>模型 / 部署名称</th><th>订阅 / 区域</th><th>资源组</th><th>Foundry / Project</th><th>版本 / SKU / 容量</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><b>'+esc(row.model_name)+'</b><small>'+esc(row.deployment_name)+'</small></td><td>'+esc(subscriptionLabel(row.subscription_id))+'<small>'+esc(row.subscription_id)+'<br>'+esc(row.location)+'</small></td><td>'+esc(row.resource_group)+'<small>'+(row.resource_group_mode==='existing'||row.group_mode==='existing'?'使用已有':'新建 / 兼容则复用')+'</small></td><td>'+esc(row.account_name)+'<small>Project · '+esc(row.project_name)+'</small></td><td>'+esc(row.model_version)+'<small>'+esc(row.sku_name)+' · '+esc(row.capacity)+'</small></td></tr>').join('')+'</tbody></table>':'<div class="empty">尚未配置模型任务。</div>';
    $('advancedOptions').open=S.mode==='custom';
    if(S.checked===S.revision) $('preflight').innerHTML='<strong class="success-text">✓ 目标只读预检通过</strong>'+S.observations.map(o=>'<div class="preflight-item">'+esc(o.label)+' · 资源组'+(o.group_action==='reuse'?'复用':'新建')+' · Foundry'+(o.account_action==='reuse'?'复用':'新建')+' · Project'+(o.project_action==='reuse'?'复用':'新建')+'</div>').join('')+'<span class="hint">已核对资源存在性、类型和区域；写权限、实时配额及模型供应情况由 Azure 部署时最终确认。</span>';
    updateLocks();
  }
  async function previewPlan(check=false) {
    const errors=[...P.validateTargets(S.targets),...P.validateTasks(S.targets,S.tasks,S.catalogs)];
    if(errors.length) throw Error(errors.join('\n'));
    const revision=S.revision,epoch=S.epoch, payload=P.payload(S.targets,S.tasks);
    const data=await api(check?'/api/check-plan':'/api/preview-plan',check?withCredentials(payload):payload);
    if(revision!==S.revision||epoch!==S.epoch) throw Error('计划已修改，请重新预检。');
    S.preview=data;
    if(check) {S.checked=revision; S.observations=data.observations||[];}
    renderPreview();
  }
  function renderJob() {
    const job=S.job;if(!job||job.status==='idle') {updateLocks();return;}
    const c=job.counts||{};
    $('jobSummary').innerHTML=[['总任务',job.total||0],['成功',c.success||0],['失败 / 未完成',c.failed||0],['执行中',c.running||0]].map(([label,count])=>'<div><small>'+label+'</small><b>'+count+'</b></div>').join('');
    $('jobMessage').textContent=job.message+(job.status==='running'?' · 排队 '+(c.pending||0)+' 项':'');
    $('jobProgress').style.width=(job.total?Math.round((job.completed||0)/job.total*100):0)+'%';
    $('jobProgress').parentElement.classList.toggle('running',job.status==='running');
    const success=new Set(['created','updated','unchanged']);
    $('jobEntries').innerHTML=(job.entries||[]).map(e=>'<div class="result-row"><div><b>'+esc(e.row.model_name)+'</b><small>'+esc(e.row.location)+' · '+esc(e.row.deployment_name)+'</small></div><span class="status-pill '+(success.has(e.status)?'ok':e.status==='running'?'running':['pending','starting'].includes(e.status)?'':'fail')+'">'+(e.status==='running'?spinner:'')+esc(e.stage)+'</span><div class="result-error">'+esc(e.error||'')+'</div></div>').join('');
    $('logs').textContent=(job.logs||[]).join('\n');
    $('jsonResult').textContent=job.report?JSON.stringify(job.report,null,2):'报告尚未生成；正在等待部署脚本。';
    $('downloads').innerHTML=(job.files||[]).filter(f=>/^results_[A-Za-z0-9_-]+\.(csv|json|xlsx)$/.test(f.name)).map(f=>'<a class="download" href="/api/download/'+encodeURIComponent(f.name)+'" download>'+esc(f.name.split('.').pop().toUpperCase())+'</a>').join('');
    $('retryFailed').hidden=job.status==='running'||!(job.entries||[]).some(e=>['failed','auth_failed','config_failed','not_run'].includes(e.status));
    updateLocks();
  }
  let pollBusy=false;
  async function refreshStatus(silent=false) {
    if(pollBusy)return;pollBusy=true;
    try {const job=await api('/api/status',undefined,12000);S.job=job;
      if(S.pendingRequest&&job.request_id===S.pendingRequest){S.pendingRequest='';S.submitting=false;notice('已找到本次部署任务，继续读取执行状态。');}
      if(S.pendingRequest && job.request_id!==S.pendingRequest){
        const receipt=await api('/api/submission-status/'+encodeURIComponent(S.pendingRequest),undefined,12000);
        if(receipt.status==='rejected'){S.pendingRequest='';S.submitting=false;S.checked=-1;notice('本次提交未执行：'+receipt.message+'。修正后请重新预检。',true);}
        else if(receipt.status==='unknown')notice('尚未确认服务器是否收到提交，请勿重新部署。恢复连接后刷新状态；若服务曾重启，请先核实 Azure 中的实际资源。',true);
      }
      renderJob();
    }catch(error){if(!silent)throw error; if(S.job?.status==='running'||S.pendingRequest) $('jobMessage').textContent='与本地服务暂时失联，结果未知；请恢复服务后刷新，不要重复部署。';}
    finally{pollBusy=false;}
  }
  async function deployPlan() {
    if(locked())return;
    if(!S.credentials)throw Error('请先连接 SP');
    const errors=planErrors();if(errors.length)throw Error(errors.join('\n'));
    // 重新生成当前计划；不要求用户先手动预检，且不绕过后端输入/资源校验。
    await previewPlan();
    if(!confirm('即将在 Azure 执行 '+S.tasks.length+' 条模型部署任务，可能产生费用。确认开始？'))return;
    const requestId=P.uid('request'); const payload={...P.payload(S.targets,S.tasks),options:options(),request_id:requestId};
    S.submitted=JSON.parse(JSON.stringify(payload));S.pendingRequest=requestId;S.submitting=true;updateLocks();
    try {const job=await api('/api/deploy',withCredentials(payload));S.job=job;S.pendingRequest='';S.checked=-1;notice('已提交部署，正在读取真实执行状态。');renderJob();}
    catch(error){if(error.definitive)S.pendingRequest='';else{notice('未能确认提交响应，正在查询本地任务状态。不要重复点击部署。',true);await refreshStatus(true);}throw error;}
    finally{S.submitting=false;updateLocks();}
  }
  function retryFailed() {
    const entries=(S.job?.entries||[]).filter(e=>['failed','auth_failed','config_failed','not_run'].includes(e.status));
    if(!entries.length)return;
    if(!S.credentials)throw Error('请重新连接 SP 后重试');
    const targets=[],tasks=[],map=new Map();
    for(const e of entries){const r=e.row,key=[r.subscription_id,r.resource_group,r.account_name,r.project_name].join('|');
      if(!map.has(key)){const t=P.newTarget(r.subscription_id);Object.assign(t,{location:r.location,resource_group:r.resource_group,group_mode:r.resource_group_mode||'new',account_name:r.account_name,account_mode:r.account_mode||'new',project_name:r.project_name,project_mode:r.project_mode||'new'});targets.push(t);map.set(key,t);}
      tasks.push({id:e.id,target_id:map.get(key).id,model_name:r.model_name,model_format:r.model_format,model_version:r.model_version,sku_name:r.sku_name,capacity:String(r.capacity),deployment_name:r.deployment_name,rai_policy_name:r.rai_policy_name||'',sequence:++S.sequence});}
    S.targets=targets;S.tasks=tasks;S.mode='custom';dirty();setPage(3);notice('仅保留 '+tasks.length+' 条失败 / 未执行任务。已成功和状态未确认的任务不会自动重试；核对计划后再次确认部署。');
    return loadCatalogs(true);
  }
  function renderManagerGroups() {
    const id=$('managerSub').value,entry=S.resources[id];
    $('managerGroups').innerHTML=entry?.status==='loading'?'<div class="empty">'+spinner+'读取中…</div>':entry?.status==='error'?'<div class="notice error">'+esc(entry.error)+'</div>':entry?.status==='ready'?(entry.data.resource_groups.map(g=>'<div class="manager-row"><span><b>'+esc(g.name)+'</b><br><small class="hint">'+esc(g.location)+'</small></span><button class="danger" data-delete-group="'+esc(g.name)+'">预览删除</button></div>').join('')||'<div class="empty">没有可读取的资源组。</div>'):'<div class="empty">选择订阅后读取资源组。</div>';
  }
  function clearAuth() {S.epoch++;S.credentials=null;S.resources={};S.projects={};S.catalogs={};S.subscriptions=[];S.checked=-1;S.deletePreview=null;for(const id of ['spPaste','clientId','clientSecret','tenantId'])$(id).value='';$('connectionBadge').textContent='尚未连接';$('connectionBadge').className='badge';$('authResult').textContent='等待连接';dirty();updateLocks();}
  function parseInputs(){const parsed=P.parseSP($('spPaste').value);$('clientId').value=parsed.AZURE_CLIENT_ID;$('clientSecret').value=parsed.AZURE_CLIENT_SECRET;$('tenantId').value=parsed.AZURE_TENANT_ID;$('spPaste').value='';$('parseInfo').textContent='已识别三项凭据，密码已隐藏。';}
  // Event delegation keeps target/task identity stable through list re-rendering.
  document.querySelectorAll('[data-page],[data-go]').forEach(b=>b.addEventListener('click',()=>setPage(+(b.dataset.page||b.dataset.go))));
  $('parseSP').onclick=()=>busy($('parseSP'),'识别中',async()=>parseInputs());
  $('clearSP').onclick=()=>{clearAuth();setPage(1);notice('凭据和查询缓存已清除，部署计划保留。');};
  $('connect').onclick=()=>busy($('connect'),'连接并读取订阅…',async()=>{
    if($('spPaste').value.trim())parseInputs();
    const credentials={AZURE_CLIENT_ID:$('clientId').value.trim(),AZURE_CLIENT_SECRET:$('clientSecret').value || (S.credentials?.AZURE_CLIENT_ID===$('clientId').value.trim() && S.credentials?.AZURE_TENANT_ID===$('tenantId').value.trim()?S.credentials.AZURE_CLIENT_SECRET:''),AZURE_TENANT_ID:$('tenantId').value.trim()};
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
    S.credentials=credentials;for(const t of S.targets)if(!t.subscription_id&&S.subscriptions.length===1)t.subscription_id=S.subscriptions[0].subscription_id;
    $('connectionBadge').textContent='已连接 · '+S.subscriptions.length+' 个订阅';$('connectionBadge').className='badge success';$('authResult').textContent='已读取 '+S.subscriptions.length+' 个可用订阅';$('clientSecret').value='';$('manualCredentials').open=false;notice('连接成功，请选择目标订阅并设置名称。');setPage(2);
  });
  ['spPaste','clientId','clientSecret','tenantId'].forEach(id=>$(id).addEventListener('input',()=>{if(S.credentials){S.credentials=null;S.epoch++;S.resources={};S.projects={};S.catalogs={};dirty();$('connectionBadge').textContent='凭据已修改，请重新连接';$('connectionBadge').className='badge';updateLocks();}}));
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{
    if(locked())return;
    if(b.dataset.mode==='standard'&&!P.canStandard(S.targets,S.tasks)){notice('当前计划包含多目标、已有 Foundry / Project 或自定义模型名称。请先调整为单目标新建 Foundry 后切换；系统不会删除现有配置。',true);return;}
    S.mode=b.dataset.mode;renderTargets();renderTasks();notice('');
  });
  $('addTarget').onclick=()=>{if(locked())return;if(S.targets.length>=20){notice('最多 20 个部署目标',true);return;}S.targets.push(P.newTarget(S.targets[0]?.subscription_id));dirty();renderTargets();};
  $('targets').addEventListener('click',event=>{
    const b=event.target.closest('button'),card=event.target.closest('[data-target]');if(!b||!card||locked())return;const t=S.targets.find(t=>t.id===card.dataset.target);
    if(b.dataset.source){switchSource(t,b.dataset.source,b.dataset.value);return;}
    if(b.dataset.action==='resources')busy(b,'读取中…',()=>loadResources(t.subscription_id,true));
    if(b.dataset.action==='projects')busy(b,'读取中…',()=>loadProjects(t,true));
    if(b.dataset.action==='remove-target'){if(S.tasks.some(task=>task.target_id===t.id)){notice('此目标仍有模型任务，请先移除任务或改选其它目标。',true);return;}S.targets=S.targets.filter(x=>x!==t);dirty();renderTargets();}
    if(b.dataset.action==='apply-names'){if(!P.slug(t.naming.base)){notice('请填写命名主体',true);return;}const name=nameSample(t);if(t.group_mode==='new')t.resource_group=P.joinName('rg',name);if(t.project_mode==='new')t.project_name=P.joinName('proj',name);dirty();renderTargets();}
  });
  $('targets').addEventListener('input',event=>{
    const el=event.target,card=el.closest('[data-target]');if(!card||!el.dataset.field||el.tagName==='SELECT'||locked())return;const t=S.targets.find(t=>t.id===card.dataset.target),key=el.dataset.field;
    if(key.startsWith('naming.')){t.naming[key.slice(7)]=el.type==='checkbox'?el.checked:el.value;card.querySelector('[data-name-sample]').textContent=nameSample(t);return;}
    t[key]=el.value.trim();dirty();card.querySelector('[data-preview-group]').textContent=t.resource_group||'待设置';card.querySelector('[data-preview-project]').textContent=t.project_name||'待设置';card.querySelector('[data-preview-account]').textContent=P.accountName(t)||'待选择';
  });
  $('targets').addEventListener('change',event=>{
    const el=event.target,card=el.closest('[data-target]');if(!card||!el.dataset.field||el.tagName!=='SELECT'||locked())return;const t=S.targets.find(t=>t.id===card.dataset.target),key=el.dataset.field;
    if(key==='subscription_id'){t.subscription_id=el.value;if(t.group_mode==='existing')t.resource_group='';if(t.account_mode==='existing')t.account_name='';if(t.project_mode==='existing')t.project_name='';t.drafts={};}
    else if(key==='resource_group'){t.resource_group=el.value;if(t.account_mode==='existing')t.account_name='';if(t.project_mode==='existing')t.project_name='';delete t.drafts['account_mode:existing'];delete t.drafts['project_mode:existing'];}
    else if(key==='account_name'){delete t.drafts['project_mode:existing'];t.account_name=el.value;const account=S.resources[t.subscription_id]?.data?.foundry_accounts?.find(a=>a.name===el.value&&a.resource_group.toLowerCase()===t.resource_group.toLowerCase());if(account)t.location=account.location;if(t.project_mode==='existing')t.project_name='';}
    else t[key]=el.value;
    dirty();renderTargets();if(t.group_mode==='existing')loadResources(t.subscription_id);if(t.project_mode==='existing'&&t.account_name)loadProjects(t);
  });
  $('toModels').onclick=()=>busy($('toModels'),'读取模型…',async()=>{const errors=P.validateTargets(S.targets);if(errors.length)throw Error(errors.join('\n'));notice('');setPage(3);await loadCatalogs();});
  $('loadModels').onclick=()=>busy($('loadModels'),'读取模型…',()=>loadCatalogs(true));
  for(const id of ['modelSearch','catalogTarget','publisherFilter'])$(id).addEventListener(id==='modelSearch'?'input':'change',()=>{S.modelLimit=36;renderCatalog();});
  $('catalogPager').onclick=()=>{S.modelLimit+=36;renderCatalog();};
  $('catalog').addEventListener('change',event=>{const key=event.target.dataset.model;if(!key||locked())return;const model=allModels().find(m=>P.modelKey(m)===key);if(!model)return;
    if(event.target.checked){if(S.tasks.length>=100){notice('单次最多 100 条任务',true);renderCatalog();return;}const selectedTarget=$('catalogTarget').value;const targets=selectedTarget?S.targets.filter(t=>t.id===selectedTarget):S.targets;S.tasks.push(P.assignModel(model,targets,S.catalogs,S.tasks,++S.sequence));}
    else S.tasks=S.tasks.filter(t=>P.modelKey({name:t.model_name,format:t.model_format})!==key);
    dirty();renderCatalog();renderTasks();
  });
  $('tasks').addEventListener('click',event=>{const b=event.target.closest('[data-task-action]'),card=event.target.closest('[data-task]');if(!b||!card||locked())return;const t=S.tasks.find(t=>t.id===card.dataset.task);
    if(b.dataset.taskAction==='remove')S.tasks=S.tasks.filter(x=>x!==t);
    else if(S.tasks.length<100){const copy={...t,id:P.uid('task'),sequence:++S.sequence,deployment_name:''};const others=S.targets.filter(x=>x.id!==t.target_id&&P.variants({name:t.model_name,format:t.model_format},x,S.catalogs).length);if(others.length)reassign(copy,others[0].id);S.tasks.push(copy);}
    dirty();renderCatalog();renderTasks();
  });
  $('tasks').addEventListener('change',event=>{const el=event.target,card=el.closest('[data-task]');if(!card||!el.dataset.field||locked())return;const task=S.tasks.find(t=>t.id===card.dataset.task),key=el.dataset.field;
    if(key==='target_id')reassign(task,el.value);
    else if(key==='guard')task.rai_policy_name=el.checked?'foundry-console-guard-low-v1':'foundry-console-guard-high-v1';
    else {task[key]=el.value.trim();if(key==='model_version'||key==='sku_name'){const target=S.targets.find(t=>t.id===task.target_id),model=P.variants({name:task.model_name,format:task.model_format},target,S.catalogs).find(m=>m.version===task.model_version);const sku=model?.skus.find(s=>s.name===task.sku_name)||P.skuFor(model);if(sku){task.sku_name=sku.name;task.capacity=String(sku.minimum||1);}}}
    dirty();renderTasks();
  });
  $('toConfirm').onclick=()=>busy($('toConfirm'),'生成确认计划…',async()=>{await previewPlan();notice('');setPage(4);});
  $('checkPlan').onclick=()=>busy($('checkPlan'),'正在只读预检…',async()=>{await previewPlan(true);notice('目标预检通过。请核对上方名称和任务数后开始部署。');});
  $('deploy').onclick=()=>busy($('deploy'),'正在提交…',deployPlan);
  ['registerProvider','updateExisting','skipQuota','concurrency'].forEach(id=>$(id).onchange=dirty);
  $('refreshStatus').onclick=()=>busy($('refreshStatus'),'刷新中…',()=>refreshStatus());
  $('retryFailed').onclick=()=>busy($('retryFailed'),'准备失败任务…',retryFailed);
  $('resourceManager').onclick=()=>{$('managerSub').innerHTML=subscriptionOptions(S.targets[0]?.subscription_id||'');$('deletePreview').hidden=true;renderManagerGroups();$('resourceDialog').showModal();};
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
  if(location.protocol==='file:'){$('fileWarning').hidden=false;$('connect').disabled=true;}else{api('/api/version').then(data=>{$('version').textContent=data.version; if(data.version!=='2026.09.30-targets-v2')notice('本地服务版本与页面不一致，请关闭旧窗口后重新运行部署.cmd。',true);}).catch(()=>notice('无法连接本地服务，请重新运行部署.cmd。',true));refreshStatus(true).then(()=>{if(S.job?.status==='running')setPage(4);});setInterval(()=>{if(S.job?.status==='running'||S.pendingRequest)refreshStatus(true);},1600);}
  renderTargets();renderModels();updateLocks();
})();
