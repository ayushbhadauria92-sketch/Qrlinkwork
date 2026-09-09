const state={user:null,csrf:null,page:'overview',language:'en'};
const translations={
en:{overview:'Overview',tasks:'Tasks',wallet:'Wallet & Ledger',deposits:'Deposits',withdrawals:'Withdrawals',invoices:'Invoices',security:'Security',owner:'Owner Control Center',logout:'Log out'},
hi:{overview:'अवलोकन',tasks:'टास्क',wallet:'वॉलेट और लेजर',deposits:'जमा',withdrawals:'निकासी',invoices:'इनवॉइस',security:'सुरक्षा',owner:'ओनर कंट्रोल सेंटर',logout:'लॉग आउट'},
zh:{overview:'概览',tasks:'任务',wallet:'钱包与账本',deposits:'存款',withdrawals:'提现',invoices:'发票',security:'安全',owner:'所有者控制中心',logout:'退出'},
es:{overview:'Resumen',tasks:'Tareas',wallet:'Billetera y libro mayor',deposits:'Depósitos',withdrawals:'Retiros',invoices:'Facturas',security:'Seguridad',owner:'Centro del propietario',logout:'Cerrar sesión'},
fr:{overview:'Vue d’ensemble',tasks:'Tâches',wallet:'Portefeuille et registre',deposits:'Dépôts',withdrawals:'Retraits',invoices:'Factures',security:'Sécurité',owner:'Centre propriétaire',logout:'Déconnexion'},
de:{overview:'Übersicht',tasks:'Aufgaben',wallet:'Wallet & Ledger',deposits:'Einzahlungen',withdrawals:'Auszahlungen',invoices:'Rechnungen',security:'Sicherheit',owner:'Owner Control Center',logout:'Abmelden'},
ja:{overview:'概要',tasks:'タスク',wallet:'ウォレットと台帳',deposits:'入金',withdrawals:'出金',invoices:'請求書',security:'セキュリティ',owner:'オーナー管理',logout:'ログアウト'},
ko:{overview:'개요',tasks:'작업',wallet:'지갑 및 원장',deposits:'입금',withdrawals:'출금',invoices:'청구서',security:'보안',owner:'소유자 센터',logout:'로그아웃'},
vi:{overview:'Tổng quan',tasks:'Nhiệm vụ',wallet:'Ví & sổ cái',deposits:'Tiền gửi',withdrawals:'Rút tiền',invoices:'Hóa đơn',security:'Bảo mật',owner:'Trung tâm chủ sở hữu',logout:'Đăng xuất'},
ru:{overview:'Обзор',tasks:'Задачи',wallet:'Кошелёк и реестр',deposits:'Депозиты',withdrawals:'Вывод',invoices:'Счета',security:'Безопасность',owner:'Центр владельца',logout:'Выйти'}
};
const $=s=>document.querySelector(s);
const api=async(url,opt={})=>{
  const headers={'Content-Type':'application/json',...(opt.headers||{})};
  if(state.csrf) headers['X-CSRF-Token']=state.csrf;
  const r=await fetch(url,{credentials:'same-origin',...opt,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||'REQUEST_FAILED');
  return data;
};
const money=(v,c='USD')=>new Intl.NumberFormat(undefined,{style:'currency',currency:c}).format(Number(v||0));
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;setTimeout(()=>t.hidden=true,2600)}
function t(key){return (translations[state.language]||translations.en)[key]||key}
function navItems(){
  const items=[['overview','⌂'],['tasks','▣'],['wallet','◈'],['deposits','↓'],['withdrawals','↑'],['invoices','▤'],['security','⌾']];
  if(['OWNER','ADMIN'].includes(state.user?.role))items.push(['owner','⚙']);
  $('#nav').innerHTML=items.map(([id,icon])=>`<button class="${state.page===id?'active':''}" data-page="${id}">${icon}<span>${t(id)}</span></button>`).join('');
  document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{state.page=b.dataset.page;render()});
}
async function render(){
  navItems(); $('#title').textContent=t(state.page); $('#avatar').textContent=(state.user?.username||'?')[0].toUpperCase();
  $('#content').innerHTML='<div class="view"><div class="panel empty">Loading secure data…</div></div>';
  try{
    if(state.page==='overview')await overview();
    else if(state.page==='tasks')await tasks();
    else if(state.page==='wallet')await wallet();
    else if(state.page==='deposits')await deposits();
    else if(state.page==='withdrawals')await withdrawals();
    else if(state.page==='invoices')await invoices();
    else if(state.page==='security')security();
    else if(state.page==='owner')await owner();
  }catch(e){$('#content').innerHTML=`<div class="view"><div class="panel empty"><div class="empty-icon">!</div><b>Unable to load</b><p>${escapeHtml(e.message)}</p></div></div>`}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function overview(){
 const [b,l]=await Promise.all([api('/api/balance'),api('/api/ledger')]);
 const completed=l.items.filter(x=>x.status==='COMPLETED').reduce((a,x)=>a+Number(x.gross_amount),0);
 const fees=l.items.reduce((a,x)=>a+Number(x.platform_fee),0);
 $('#content').innerHTML=`<div class="view">
 <section class="hero"><span class="pill">● RECORDED DATA</span><h2>Secure work, transparent payments.</h2><p>LinkWork keeps balances server-side. Deposits are not credited until authorized provider verification succeeds.</p></section>
 <div class="metrics"><div class="metric"><span>Recorded balance</span><strong>${money(b.balance?.available_amount,b.balance?.currency)}</strong><small>Usable after server settlement</small></div>
 <div class="metric"><span>Total submitted</span><strong>${money(completed,b.balance?.currency)}</strong><small>Recorded completed tasks</small></div>
 <div class="metric"><span>Pending</span><strong>${money(b.balance?.pending_amount,b.balance?.currency)}</strong><small>Awaiting approval</small></div>
 <div class="metric"><span>Platform fees</span><strong>${money(fees,b.balance?.currency)}</strong><small>Ledger history</small></div></div>
 <div class="grid2"><article class="panel"><div class="panel-head"><div><span class="kicker">LEDGER</span><h3>Recent transactions</h3></div></div>${tableLedger(l.items.slice(0,6))}</article>
 <article class="panel"><div class="panel-head"><div><span class="kicker">PROTECTION</span><h3>Financial safeguards</h3></div></div><div class="empty"><div class="empty-icon">✓</div><b>Server verified workflow</b><p>Balance changes are created through transactional ledger operations, not browser state.</p></div></article></div></div>`;
}
function tableLedger(items){if(!items.length)return '<div class="empty"><div class="empty-icon">◌</div><b>No ledger entries</b><p>Your financial history will appear here.</p></div>';return `<div class="table"><table><thead><tr><th>Status</th><th>Gross</th><th>Fee</th><th>Net</th><th>Date</th></tr></thead><tbody>${items.map(x=>`<tr><td><span class="status">${x.status}</span></td><td>${money(x.gross_amount,x.currency)}</td><td>${money(x.platform_fee,x.currency)}</td><td>${money(x.net_amount,x.currency)}</td><td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`}
async function tasks(){
 const data=await api('/api/tasks');
 $('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">WORKSPACE</span><h2>Tasks</h2></div>${state.user.role==='CLIENT'?'<button class="primary" id="newTask">+ Create task</button>':''}</div><article class="panel"><div class="filters"><input id="search" placeholder="Search tasks…"><button class="primary" id="refresh">Refresh</button></div>${data.items.length?`<div class="table"><table><thead><tr><th>Task</th><th>Client</th><th>Worker</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.items.map(x=>`<tr><td>${escapeHtml(x.title)}</td><td>${escapeHtml(x.client_username)}</td><td>${escapeHtml(x.worker_username||'—')}</td><td>${money(x.gross_amount,x.currency)}</td><td><span class="status">${x.status}</span></td><td>${state.user.role==='WORKER'&&x.status==='OPEN'?`<button class="primary claim" data-id="${x.id}">Claim</button>`:state.user.role==='WORKER'&&x.status==='CLAIMED'&&x.worker_username===state.user.username?`<button class="primary submit" data-id="${x.id}">Submit</button>`:state.user.role==='CLIENT'&&x.status==='SUBMITTED'?`<button class="primary approve" data-id="${x.id}">Approve</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><div class="empty-icon">▣</div><b>No tasks</b><p>Tasks will appear after authenticated creation.</p></div>'}</article></div>`;
 $('#refresh').onclick=render;
 document.querySelectorAll('.claim').forEach(b=>b.onclick=async()=>{try{await api('/api/tasks/'+b.dataset.id+'/claim',{method:'POST'});toast('Task claimed');render()}catch(e){toast(e.message)}});
 document.querySelectorAll('.submit').forEach(b=>b.onclick=async()=>{try{await api('/api/tasks/'+b.dataset.id+'/submit',{method:'POST'});toast('Task submitted');render()}catch(e){toast(e.message)}});
 document.querySelectorAll('.approve').forEach(b=>b.onclick=async()=>{try{await api('/api/tasks/'+b.dataset.id+'/approve',{method:'POST'});toast('Task approved and ledger recorded');render()}catch(e){toast(e.message)}});
 $('#newTask')?.addEventListener('click',()=>toast('Task creation form is ready for the next UI module.'));
}
async function wallet(){const [b,l]=await Promise.all([api('/api/balance'),api('/api/ledger')]);$('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">FINANCE</span><h2>Wallet & Ledger</h2></div></div><div class="metrics"><div class="metric"><span>Available balance</span><strong>${money(b.balance?.available_amount,b.balance?.currency)}</strong><small>Recorded balance</small></div><div class="metric"><span>Pending</span><strong>${money(b.balance?.pending_amount,b.balance?.currency)}</strong><small>Not yet available</small></div></div><article class="panel">${tableLedger(l.items)}</article></div>`}
async function deposits(){const data={items:[]};$('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">FUNDING</span><h2>Deposits</h2></div></div><div class="notice"><b>Deposit protection:</b> a submitted deposit cannot increase usable balance until an authorized provider verifies it on the server.</div><article class="panel"><div class="empty"><div class="empty-icon">↓</div><b>Deposit request endpoint enabled</b><p>Connect an authorized provider adapter and its signed webhook before enabling automatic verification.</p></div></article></div>`}
async function withdrawals(){const data=await api('/api/withdrawals');$('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">PAYOUTS</span><h2>Withdrawals</h2></div></div><div class="notice"><b>Manual Review:</b> withdrawal requests reserve recorded balance and require Owner/Admin review. No automatic transfer is performed by this application.</div><article class="panel">${data.items.length?`<div class="table"><table><thead><tr><th>Amount</th><th>Method</th><th>Destination</th><th>Status</th><th>Date</th></tr></thead><tbody>${data.items.map(x=>`<tr><td>${money(x.amount,x.currency)}</td><td>${escapeHtml(x.payout_method)}</td><td>••••${x.destination_last4||''}</td><td><span class="status">${x.status}</span></td><td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><div class="empty-icon">↑</div><b>No withdrawal requests</b><p>Available recorded balance can be requested through the secure API.</p></div>'}</article></div>`}
async function invoices(){const data=await api('/api/invoices');$('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">BILLING</span><h2>Invoices</h2></div></div><article class="panel">${data.items.length?`<div class="table"><table><thead><tr><th>Invoice</th><th>Task</th><th>Gross</th><th>Fee</th><th>Tax</th><th>Net</th><th>Status</th></tr></thead><tbody>${data.items.map(x=>`<tr><td>${escapeHtml(x.invoice_number)}</td><td>${escapeHtml(x.task_id)}</td><td>${money(x.gross_amount,x.currency)}</td><td>${money(x.platform_fee,x.currency)}</td><td>${money(x.tax_amount,x.currency)}</td><td>${money(x.net_worker_amount,x.currency)}</td><td>${x.payment_status}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><div class="empty-icon">▤</div><b>No invoices</b><p>Completed, server-confirmed task settlements generate billing records.</p></div>'}</article></div>`}
function security(){$('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">ACCOUNT</span><h2>Security</h2></div></div><div class="grid2"><article class="panel"><div class="panel-head"><div><span class="kicker">AUTH</span><h3>Protection</h3></div></div><div class="empty"><div class="empty-icon">⌾</div><b>Server-side session</b><p>HTTP-only session cookies, Argon2id password hashing, RBAC and CSRF protection are enforced by the API.</p></div></article><article class="panel"><div class="panel-head"><div><span class="kicker">FINANCE</span><h3>Data handling</h3></div></div><div class="empty"><div class="empty-icon">◈</div><b>No financial secrets in browser storage</b><p>Provider secrets remain server-side. Payout destinations are masked in the interface.</p></div></article></div></div>`}
async function owner(){
 const [o,a]=await Promise.all([api('/api/owner/overview'),api('/api/owner/audit-logs?limit=20')]);
 $('#content').innerHTML=`<div class="view"><div class="head"><div><span class="kicker">PRIVATE ADMINISTRATION</span><h2>Owner Control Center</h2></div><span class="pill">OWNER / ADMIN ONLY</span></div>
 <div class="metrics"><div class="metric"><span>Total users</span><strong>${o.users.total}</strong><small>${o.users.clients} clients · ${o.users.workers} workers</small></div><div class="metric"><span>Active tasks</span><strong>${o.tasks.active}</strong><small>${o.tasks.completed} completed</small></div><div class="metric"><span>Recorded volume</span><strong>${money(o.ledger.volume)}</strong><small>Completed ledger</small></div><div class="metric"><span>Platform fees</span><strong>${money(o.ledger.fees)}</strong><small>Recorded fees</small></div></div>
 <div class="admin-grid"><article class="panel"><div class="panel-head"><div><span class="kicker">OPERATIONS</span><h3>Control modules</h3></div></div><div class="admin-actions"><button>User management</button><button>Task management</button><button>Deposit review (${o.pendingDeposits})</button><button>Withdrawal review (${o.pendingWithdrawals})</button><button>Disputes (${o.disputes})</button><button>Accounting export</button></div></article>
 <article class="panel"><div class="panel-head"><div><span class="kicker">SETTINGS</span><h3>Server configuration</h3></div></div><div class="settings"><label>Platform fee percentage<input id="fee" type="number" step="0.01" min="0" placeholder="Server configured"></label><button class="primary" id="saveFee">Save setting</button></div><p class="muted">Changes are persisted server-side and audited. Tax/GST remains disabled unless the Owner configures the required jurisdictional information.</p></article></div>
 <article class="panel" style="margin-top:15px"><div class="panel-head"><div><span class="kicker">AUDIT LOG</span><h3>Administrative events</h3></div></div>${a.items.length?`<div class="table"><table><thead><tr><th>Action</th><th>Actor</th><th>Resource</th><th>Result</th><th>Date</th></tr></thead><tbody>${a.items.map(x=>`<tr><td>${escapeHtml(x.action)}</td><td>${escapeHtml(x.actor_user_id||'system')}</td><td>${escapeHtml(x.resource_type||'—')} ${escapeHtml(x.resource_id||'')}</td><td>${x.result}</td><td>${new Date(x.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><div class="empty-icon">◈</div><b>No audit events</b><p>Production events are appended by the server.</p></div>'}</article></div>`;
 $('#saveFee').onclick=async()=>{const value=Number($('#fee').value);if(!(value>=0))return toast('Enter a valid percentage');try{await api('/api/owner/settings/platform_fee_percentage',{method:'PUT',body:JSON.stringify({value})});toast('Setting saved and audited');}catch(e){toast(e.message)}};
}
async function boot(){
 try{
  const me=await api('/api/me');state.user=me.user;state.language=me.user.language||'en';
  const csrf=await api('/api/csrf');state.csrf=csrf.csrfToken;
  $('#language').value=state.language;$('#language').onchange=async e=>{state.language=e.target.value;try{await api('/api/me/language',{method:'PATCH',body:JSON.stringify({language:state.language})});render()}catch(x){toast(x.message)}};
  $('#logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});location.reload()}catch(e){toast(e.message)}};
  $('#menu').onclick=()=>document.querySelector('.sidebar').classList.toggle('open');
  render();
 }catch(e){document.body.innerHTML=`<main style="min-height:100vh;display:grid;place-items:center;padding:25px;background:#070b16;color:white;font-family:Inter,sans-serif"><section style="max-width:520px;text-align:center"><h1>LinkWork</h1><p style="color:#98a4bd">No authenticated session is active. Connect the login/signup pages to this production API before deployment.</p><p style="color:#66738f;font-size:12px">This application intentionally contains no demo account or fake financial data.</p></section></main>`}
}
boot();
