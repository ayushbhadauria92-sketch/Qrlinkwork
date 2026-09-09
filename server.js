import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import argon2 from 'argon2';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const sessionCookie = 'lw_session';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const requestId = req => req.headers['x-request-id']?.toString() || crypto.randomUUID();

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Number(process.env.SESSION_TTL_HOURS || 12) * 3600}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}${process.env.COOKIE_DOMAIN ? `; Domain=${process.env.COOKIE_DOMAIN}` : ''}`;
}
function clearCookie() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const found = header.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}
function safeJson(value) { return value ?? {}; }

async function audit(client, req, actor, action, resourceType, resourceId, previousState, newState, result, reason = null, metadata = {}) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,actor_role,action,resource_type,resource_id,previous_state,new_state,ip_hash,user_agent,request_id,result,reason,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [actor?.id || null, actor?.role || null, action, resourceType || null, resourceId || null,
     previousState ? JSON.stringify(previousState) : null, newState ? JSON.stringify(newState) : null,
     sha256(req.ip || ''), req.get('user-agent') || '', requestId(req), result, reason, JSON.stringify(metadata)]
  );
}

async function auth(req, res, next) {
  try {
    const raw = getCookie(req, sessionCookie);
    if (!raw) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    const tokenHash = sha256(raw);
    const result = await pool.query(
      `SELECT s.id AS session_id,s.csrf_hash,s.expires_at,u.id,u.email,u.username,u.role,u.status,u.language
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [tokenHash]
    );
    if (!result.rowCount || result.rows[0].status !== 'ACTIVE') return res.status(401).json({ error: 'SESSION_INVALID' });
    req.user = result.rows[0];
    req.sessionId = result.rows[0].session_id;
    req.csrfHash = result.rows[0].csrf_hash;
    await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [req.sessionId]);
    next();
  } catch (error) { next(error); }
}

function roles(...allowed) {
  return (req,res,next) => allowed.includes(req.user?.role) ? next() : res.status(403).json({ error: 'FORBIDDEN' });
}

function csrf(req,res,next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const supplied = req.get('x-csrf-token');
  if (!supplied || !req.csrfHash || sha256(supplied) !== req.csrfHash) return res.status(403).json({ error: 'CSRF_INVALID' });
  next();
}

function parse(schema, source='body') {
  return (req,res,next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: result.error.flatten() });
    req[source] = result.data;
    next();
  };
}

const credentials = z.object({
  email: z.string().email().max(254).transform(v=>v.toLowerCase()),
  password: z.string().min(12).max(200)
});
const registerSchema = credentials.extend({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  role: z.enum(['CLIENT','WORKER']),
  language: z.enum(['en','hi','zh','es','fr','de','ja','ko','vi','ru']).default('en')
});
const taskSchema = z.object({
  title:z.string().min(3).max(160),
  description:z.string().min(3).max(10000),
  grossAmount:z.number().positive().max(100000000),
  currency:z.string().length(3).transform(v=>v.toUpperCase()),
  dueAt:z.string().datetime().optional()
});
const withdrawalSchema = z.object({
  amount:z.number().positive(),
  currency:z.string().length(3).transform(v=>v.toUpperCase()),
  payoutMethod:z.string().min(2).max(80),
  destination:z.string().min(2).max(500)
});
const depositSchema = z.object({
  amount:z.number().positive(),
  currency:z.string().length(3).transform(v=>v.toUpperCase()),
  provider:z.string().min(2).max(80),
  providerReference:z.string().max(200).optional()
});

app.get('/health', async (_req,res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true, database:true, time:new Date().toISOString() }); }
  catch { res.status(503).json({ ok:false, database:false }); }
});

app.get('/api/csrf', auth, (req,res)=>{
  const token=randomToken();
  pool.query('UPDATE sessions SET csrf_hash=$1 WHERE id=$2',[sha256(token),req.sessionId])
    .then(()=>res.json({ csrfToken:token }))
    .catch(()=>res.status(500).json({error:'SERVER_ERROR'}));
});

app.post('/api/auth/register', authLimiter, parse(registerSchema), async (req,res,next)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash=await argon2.hash(req.body.password,{type:argon2.argon2id});
    const user=await client.query(
      `INSERT INTO users(email,username,password_hash,role,language) VALUES($1,$2,$3,$4,$5) RETURNING id,email,username,role,status,language,created_at`,
      [req.body.email,req.body.username,passwordHash,req.body.role,req.body.language]
    );
    const u=user.rows[0];
    await client.query('INSERT INTO balances(user_id,currency) VALUES($1,$2)',[u.id,'USD']);
    if(u.role==='CLIENT') await client.query('INSERT INTO clients(user_id) VALUES($1)',[u.id]);
    if(u.role==='WORKER') await client.query('INSERT INTO workers(user_id) VALUES($1)',[u.id]);
    await audit(client,req,u,'ACCOUNT_CREATED','user',u.id,null,u,'SUCCESS');
    await client.query('COMMIT');
    res.status(201).json({ user:u });
  } catch(e){ await client.query('ROLLBACK'); if(e.code==='23505') return res.status(409).json({error:'ACCOUNT_ALREADY_EXISTS'}); next(e); }
  finally{client.release();}
});

app.post('/api/auth/login', authLimiter, parse(credentials), async (req,res,next)=>{
  try {
    const found=await pool.query(`SELECT id,email,username,password_hash,role,status,language FROM users WHERE email=$1`,[req.body.email]);
    if(!found.rowCount) return res.status(401).json({error:'INVALID_CREDENTIALS'});
    const user=found.rows[0];
    const ok=await argon2.verify(user.password_hash,req.body.password);
    if(!ok){ await pool.query(`INSERT INTO audit_logs(action,result,metadata,ip_hash,user_agent,request_id) VALUES('LOGIN_FAILED','FAILURE',$1,$2,$3,$4)`,[JSON.stringify({email:req.body.email}),sha256(req.ip||''),req.get('user-agent')||'',requestId(req)]); return res.status(401).json({error:'INVALID_CREDENTIALS'}); }
    if(user.status!=='ACTIVE') return res.status(403).json({error:'ACCOUNT_NOT_ACTIVE'});
    const raw=randomToken(), csrfToken=randomToken();
    const ttl=Number(process.env.SESSION_TTL_HOURS||12);
    await pool.query(`INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at,ip_hash,user_agent) VALUES($1,$2,$3,now()+($4||' hours')::interval,$5,$6)`,
      [user.id,sha256(raw),sha256(csrfToken),String(ttl),sha256(req.ip||''),req.get('user-agent')||'']);
    res.setHeader('Set-Cookie',`${sessionCookie}=${encodeURIComponent(raw)}; ${cookieOptions()}`);
    await pool.query(`INSERT INTO audit_logs(actor_user_id,actor_role,action,result,ip_hash,user_agent,request_id) VALUES($1,$2,'LOGIN','SUCCESS',$3,$4,$5)`,
      [user.id,user.role,sha256(req.ip||''),req.get('user-agent')||'',requestId(req)]);
    res.json({user:{id:user.id,email:user.email,username:user.username,role:user.role,language:user.language},csrfToken});
  } catch(e){next(e);}
});

app.post('/api/auth/logout', auth, csrf, async (req,res,next)=>{
  try { await pool.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]); res.setHeader('Set-Cookie',`${sessionCookie}=; ${clearCookie()}`); res.json({ok:true}); }
  catch(e){next(e);}
});

app.get('/api/me', auth, async(req,res)=>res.json({user:{id:req.user.id,email:req.user.email,username:req.user.username,role:req.user.role,status:req.user.status,language:req.user.language}}));

app.patch('/api/me/language', auth, csrf, z.any().optional(), async(req,res,next)=>{
  try {
    const language=z.enum(['en','hi','zh','es','fr','de','ja','ko','vi','ru']).parse(req.body.language);
    await pool.query('UPDATE users SET language=$1,updated_at=now() WHERE id=$2',[language,req.user.id]);
    res.json({language});
  } catch(e){ if(e.name==='ZodError') return res.status(400).json({error:'VALIDATION_ERROR'}); next(e); }
});

app.get('/api/tasks', auth, async(req,res,next)=>{
  try {
    const {status,search,limit='20',offset='0'}=req.query;
    const lim=Math.min(Math.max(Number(limit)||20,1),100), off=Math.max(Number(offset)||0,0);
    const params=[req.user.id], where=[];
    if(req.user.role==='CLIENT') where.push(`t.client_id=$1`);
    else if(req.user.role==='WORKER') where.push(`(t.worker_id=$1 OR t.worker_id IS NULL)`);
    if(status){params.push(status);where.push(`t.status=$${params.length}`);}
    if(search){params.push(`%${String(search).slice(0,100)}%`);where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);}
    params.push(lim,off);
    const q=`SELECT t.id,t.title,t.description,t.gross_amount,t.currency,t.platform_fee,t.tax_amount,t.net_worker_amount,t.status,t.due_at,t.created_at,
             cu.username client_username,wu.username worker_username
             FROM tasks t JOIN users cu ON cu.id=t.client_id LEFT JOIN users wu ON wu.id=t.worker_id
             ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY t.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
    const rows=await pool.query(q,params);
    res.json({items:rows.rows,limit:lim,offset:off});
  } catch(e){next(e);}
});

app.post('/api/tasks', auth, roles('CLIENT'), csrf, parse(taskSchema), async(req,res,next)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const settings=await client.query(`SELECT key,value FROM platform_settings WHERE key IN ('platform_fee_percentage','minimum_task_amount','maximum_task_amount','worker_active_task_limit')`);
    const map=Object.fromEntries(settings.rows.map(x=>[x.key,x.value]));
    const min=Number(map.minimum_task_amount?.amount ?? 0), max=Number(map.maximum_task_amount?.amount ?? Infinity);
    if(req.body.grossAmount<min || req.body.grossAmount>max) throw Object.assign(new Error('TASK_AMOUNT_OUT_OF_RANGE'),{statusCode:400});
    const feePct=Number(map.platform_fee_percentage?.value ?? 0);
    const fee=Number((req.body.grossAmount*feePct/100).toFixed(8));
    const tax=0;
    const net=Number((req.body.grossAmount-fee-tax).toFixed(8));
    const task=await client.query(`INSERT INTO tasks(client_id,title,description,gross_amount,currency,platform_fee,tax_amount,net_worker_amount,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id,req.body.title,req.body.description,req.body.grossAmount,req.body.currency,fee,tax,net,req.body.dueAt||null]);
    await client.query(`INSERT INTO task_events(task_id,actor_id,event_type,payload) VALUES($1,$2,'TASK_CREATED',$3)`,[task.rows[0].id,req.user.id,JSON.stringify({})]);
    await audit(client,req,req.user,'TASK_CREATED','task',task.rows[0].id,null,task.rows[0],'SUCCESS');
    await client.query('COMMIT');
    res.status(201).json({task:task.rows[0]});
  } catch(e){await client.query('ROLLBACK');next(e);} finally{client.release();}
});

app.post('/api/tasks/:id/claim', auth, roles('WORKER'), csrf, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const t=await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!t.rowCount || t.rows[0].status!=='OPEN') throw Object.assign(new Error('TASK_NOT_AVAILABLE'),{statusCode:409});
    const worker=await client.query('SELECT * FROM workers WHERE user_id=$1 FOR UPDATE',[req.user.id]);
    const limitRow=await client.query(`SELECT value FROM platform_settings WHERE key='worker_active_task_limit'`);
    const max=Number(limitRow.rows[0]?.value?.value ?? 10);
    if((worker.rows[0]?.active_task_count||0)>=max) throw Object.assign(new Error('ACTIVE_TASK_LIMIT'),{statusCode:409});
    const updated=await client.query(`UPDATE tasks SET worker_id=$1,status='CLAIMED',updated_at=now() WHERE id=$2 RETURNING *`,[req.user.id,req.params.id]);
    await client.query(`UPDATE workers SET active_task_count=active_task_count+1 WHERE user_id=$1`,[req.user.id]);
    await client.query(`INSERT INTO task_events(task_id,actor_id,event_type) VALUES($1,$2,'TASK_CLAIMED')`,[req.params.id,req.user.id]);
    await audit(client,req,req.user,'TASK_CLAIMED','task',req.params.id,t.rows[0],updated.rows[0],'SUCCESS');
    await client.query('COMMIT');res.json({task:updated.rows[0]});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

app.post('/api/tasks/:id/submit', auth, roles('WORKER'), csrf, async(req,res,next)=>{
  try{
    const r=await pool.query(`UPDATE tasks SET status='SUBMITTED',submitted_at=now(),updated_at=now()
      WHERE id=$1 AND worker_id=$2 AND status='CLAIMED' RETURNING *`,[req.params.id,req.user.id]);
    if(!r.rowCount) return res.status(409).json({error:'TASK_NOT_SUBMITTABLE'});
    await pool.query(`INSERT INTO task_events(task_id,actor_id,event_type) VALUES($1,$2,'TASK_SUBMITTED')`,[req.params.id,req.user.id]);
    await pool.query(`INSERT INTO audit_logs(actor_user_id,actor_role,action,resource_type,resource_id,result,ip_hash,user_agent,request_id) VALUES($1,$2,'TASK_SUBMITTED','task',$3,'SUCCESS',$4,$5,$6)`,
      [req.user.id,req.user.role,req.params.id,sha256(req.ip||''),req.get('user-agent')||'',requestId(req)]);
    res.json({task:r.rows[0]});
  }catch(e){next(e);}
});

app.post('/api/tasks/:id/approve', auth, roles('CLIENT'), csrf, async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const t=await client.query(`SELECT t.*,cu.username client_username,wu.username worker_username FROM tasks t JOIN users cu ON cu.id=t.client_id LEFT JOIN users wu ON wu.id=t.worker_id WHERE t.id=$1 FOR UPDATE`,[req.params.id]);
    if(!t.rowCount || t.rows[0].client_id!==req.user.id || t.rows[0].status!=='SUBMITTED') throw Object.assign(new Error('TASK_NOT_APPROVABLE'),{statusCode:409});
    const task=t.rows[0];
    const tax=Number(task.tax_amount), fee=Number(task.platform_fee), gross=Number(task.gross_amount), net=Number(task.net_worker_amount);
    const invoice=`LW-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await client.query(`INSERT INTO billing_records(invoice_number,task_id,client_id,worker_id,gross_amount,platform_fee,tax_amount,net_worker_amount,currency,payment_status,provider_reference,tax_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETED',NULL,$10)`,
      [invoice,task.id,task.client_id,task.worker_id,gross,fee,tax,net,task.currency,JSON.stringify({configured:false})]);
    const tx=crypto.randomUUID();
    await client.query(`INSERT INTO ledger_entries(transaction_id,task_id,user_id,client_id,worker_id,gross_amount,platform_fee,tax_amount,net_amount,currency,status,description)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'COMPLETED',$11)`,
      [tx,task.id,task.worker_id,task.client_id,task.worker_id,gross,fee,tax,net,task.currency,`Approved task ${task.id}`]);
    await client.query(`UPDATE balances SET available_amount=available_amount+$1,updated_at=now() WHERE user_id=$2`,[net,task.worker_id]);
    await client.query(`UPDATE tasks SET status='APPROVED',approved_at=now(),updated_at=now() WHERE id=$1`,[task.id]);
    await client.query(`UPDATE workers SET active_task_count=GREATEST(active_task_count-1,0) WHERE user_id=$1`,[task.worker_id]);
    await client.query(`INSERT INTO notifications(user_id,type,title,body,metadata) VALUES($1,'TASK_APPROVED','Task approved',$2,$3)`,
      [task.worker_id,`Task ${task.id} was approved and recorded to your balance.`,JSON.stringify({taskId:task.id,invoiceNumber:invoice})]);
    await audit(client,req,req.user,'TASK_APPROVED','task',task.id,{status:task.status},{status:'APPROVED',invoiceNumber:invoice,transactionId:tx},'SUCCESS');
    await client.query('COMMIT');
    res.json({taskId:task.id,invoiceNumber:invoice,transactionId:tx,status:'APPROVED'});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

app.get('/api/balance', auth, async(req,res,next)=>{
  try{const r=await pool.query('SELECT currency,available_amount,pending_amount,updated_at FROM balances WHERE user_id=$1',[req.user.id]);res.json({balance:r.rows[0]||null});}catch(e){next(e);}
});
app.get('/api/ledger', auth, async(req,res,next)=>{
  try{const r=await pool.query(`SELECT transaction_id,task_id,gross_amount,platform_fee,tax_amount,net_amount,currency,status,description,provider_reference,created_at
    FROM ledger_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.id]);res.json({items:r.rows});}catch(e){next(e);}
});

app.post('/api/deposits', auth, csrf, parse(depositSchema), async(req,res,next)=>{
  try{
    const r=await pool.query(`INSERT INTO deposits(user_id,amount,currency,provider,provider_reference,status,verification_status)
      VALUES($1,$2,$3,$4,$5,'PENDING','UNVERIFIED') RETURNING id,amount,currency,provider,provider_reference,status,verification_status,created_at`,
      [req.user.id,req.body.amount,req.body.currency,req.body.provider,req.body.providerReference||null]);
    await pool.query(`INSERT INTO audit_logs(actor_user_id,actor_role,action,resource_type,resource_id,result,metadata,ip_hash,user_agent,request_id)
      VALUES($1,$2,'DEPOSIT_SUBMITTED','deposit',$3,'SUCCESS',$4,$5,$6,$7)`,
      [req.user.id,req.user.role,r.rows[0].id,JSON.stringify({provider:req.body.provider}),sha256(req.ip||''),req.get('user-agent')||'',requestId(req)]);
    res.status(201).json({deposit:r.rows[0]});
  }catch(e){next(e);}
});

app.post('/api/withdrawals', auth, csrf, parse(withdrawalSchema), async(req,res,next)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const b=await client.query(`SELECT * FROM balances WHERE user_id=$1 FOR UPDATE`,[req.user.id]);
    if(!b.rowCount || Number(b.rows[0].available_amount)<req.body.amount) throw Object.assign(new Error('INSUFFICIENT_RECORDED_BALANCE'),{statusCode:409});
    const limits=await client.query(`SELECT key,value FROM platform_settings WHERE key IN ('minimum_withdrawal','maximum_withdrawal')`);
    const map=Object.fromEntries(limits.rows.map(x=>[x.key,x.value]));
    const min=Number(map.minimum_withdrawal?.amount ?? 0), max=Number(map.maximum_withdrawal?.amount ?? Infinity);
    if(req.body.amount<min || req.body.amount>max) throw Object.assign(new Error('WITHDRAWAL_LIMIT'),{statusCode:400});
    const destinationHash=sha256(req.body.destination);
    const w=await client.query(`INSERT INTO withdrawals(user_id,amount,currency,payout_method,destination_last4,status)
      VALUES($1,$2,$3,$4,$5,'WITHDRAWAL_REVIEW') RETURNING id,amount,currency,payout_method,status,created_at`,
      [req.user.id,req.body.amount,req.body.currency,req.body.payoutMethod,destinationHash.slice(-4)]);
    await client.query(`UPDATE balances SET available_amount=available_amount-$1,updated_at=now() WHERE user_id=$2`,[req.body.amount,req.user.id]);
    await client.query(`INSERT INTO ledger_entries(transaction_id,user_id,gross_amount,net_amount,currency,status,description)
      VALUES($1,$2,$3,$3,$4,'WITHDRAWAL_REVIEW',$5)`,[crypto.randomUUID(),req.user.id,req.body.amount,req.body.currency,`Withdrawal request ${w.rows[0].id}`]);
    await audit(client,req,req.user,'WITHDRAWAL_REQUESTED','withdrawal',w.rows[0].id,{available:b.rows[0].available_amount},w.rows[0],'SUCCESS');
    await client.query('COMMIT');res.status(201).json({withdrawal:w.rows[0]});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

app.get('/api/withdrawals', auth, async(req,res,next)=>{
  try{const r=await pool.query(`SELECT id,amount,currency,payout_method,destination_last4,status,provider_reference,created_at,updated_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);res.json({items:r.rows});}catch(e){next(e);}
});

app.get('/api/invoices', auth, async(req,res,next)=>{
  try{const r=await pool.query(`SELECT id,invoice_number,task_id,gross_amount,platform_fee,tax_amount,net_worker_amount,currency,payment_status,provider_reference,created_at
    FROM billing_records WHERE client_id=$1 OR worker_id=$1 ORDER BY created_at DESC`,[req.user.id]);res.json({items:r.rows});}catch(e){next(e);}
});

app.post('/api/webhooks/:provider', express.raw({type:'application/json',limit:'512kb'}), async(req,res,next)=>{
  const provider=req.params.provider;
  const signature=req.get('x-provider-signature')||'';
  const secret=process.env.WEBHOOK_SECRET||'';
  const body=req.body;
  const expected=secret ? crypto.createHmac('sha256',secret).update(body).digest('hex') : '';
  const valid=Boolean(secret && signature && crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)));
  let payload={};
  try{payload=JSON.parse(body.toString('utf8'));}catch{return res.status(400).json({error:'INVALID_JSON'});}
  const eventId=String(payload.id||payload.event_id||'');
  if(!eventId) return res.status(400).json({error:'EVENT_ID_REQUIRED'});
  if(!valid){await pool.query(`INSERT INTO webhook_events(provider,event_id,signature_valid,payload) VALUES($1,$2,false,$3) ON CONFLICT DO NOTHING`,[provider,eventId,JSON.stringify(payload)]);return res.status(401).json({error:'WEBHOOK_SIGNATURE_INVALID'});}
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const existing=await client.query(`SELECT id FROM webhook_events WHERE provider=$1 AND event_id=$2 FOR UPDATE`,[provider,eventId]);
    if(existing.rowCount){await client.query('COMMIT');return res.json({received:true,idempotent:true});}
    await client.query(`INSERT INTO webhook_events(provider,event_id,signature_valid,payload) VALUES($1,$2,true,$3)`,[provider,eventId,JSON.stringify(payload)]);
    // Provider-specific adapters belong here. Never credit a deposit from an unverified browser request.
    await client.query('COMMIT');
    res.json({received:true,processed:false,reason:'PROVIDER_ADAPTER_REQUIRED'});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

app.get('/api/owner/overview', auth, roles('OWNER','ADMIN'), async(req,res,next)=>{
  try{
    const [users,tasks,ledger,withdrawals,deposits,disputes]=await Promise.all([
      pool.query(`SELECT count(*) total,count(*) FILTER(WHERE role='CLIENT') clients,count(*) FILTER(WHERE role='WORKER') workers FROM users WHERE status<>'CLOSED'`),
      pool.query(`SELECT count(*) FILTER(WHERE status IN ('OPEN','CLAIMED','SUBMITTED','DISPUTED')) active,count(*) FILTER(WHERE status='APPROVED') completed FROM tasks`),
      pool.query(`SELECT COALESCE(sum(gross_amount),0) volume,COALESCE(sum(platform_fee),0) fees FROM ledger_entries WHERE status='COMPLETED'`),
      pool.query(`SELECT count(*) FROM withdrawals WHERE status IN ('WITHDRAWAL_REQUESTED','WITHDRAWAL_REVIEW','APPROVED','PROCESSING')`),
      pool.query(`SELECT count(*) FROM deposits WHERE status IN ('PENDING','UNDER_REVIEW')`),
      pool.query(`SELECT count(*) FROM disputes WHERE status='OPEN'`)
    ]);
    res.json({users:users.rows[0],tasks:tasks.rows[0],ledger:ledger.rows[0],pendingWithdrawals:withdrawals.rows[0].count,pendingDeposits:deposits.rows[0].count,disputes:disputes.rows[0].count});
  }catch(e){next(e);}
});

app.get('/api/owner/audit-logs', auth, roles('OWNER','ADMIN'), async(req,res,next)=>{
  try{
    const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200), offset=Math.max(Number(req.query.offset)||0,0);
    const r=await pool.query(`SELECT id,actor_user_id,actor_role,action,resource_type,resource_id,result,reason,metadata,created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,[limit,offset]);
    res.json({items:r.rows,limit,offset});
  }catch(e){next(e);}
});

app.get('/api/owner/settings', auth, roles('OWNER','ADMIN'), async(req,res,next)=>{
  try{const r=await pool.query(`SELECT key,value,version,updated_at FROM platform_settings ORDER BY key`);const tax=await pool.query(`SELECT * FROM tax_settings WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY effective_from DESC LIMIT 1`);res.json({settings:r.rows,tax:tax.rows[0]||null});}catch(e){next(e);}
});

app.put('/api/owner/settings/:key', auth, roles('OWNER','ADMIN'), csrf, async(req,res,next)=>{
  const allowed=new Set(['platform_fee_percentage','minimum_task_amount','maximum_task_amount','minimum_withdrawal','maximum_withdrawal','worker_active_task_limit','task_timeout','review_period','enabled_languages','enabled_payment_providers','notification_settings']);
  if(!allowed.has(req.params.key)) return res.status(400).json({error:'SETTING_NOT_ALLOWED'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const old=await client.query(`SELECT value,version FROM platform_settings WHERE key=$1 FOR UPDATE`,[req.params.key]);
    const value=req.body;
    await client.query(`INSERT INTO platform_settings(key,value,version,updated_by) VALUES($1,$2,1,$3)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=platform_settings.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [req.params.key,JSON.stringify(value),req.user.id]);
    await audit(client,req,req.user,'OWNER_SETTING_CHANGED','platform_setting',req.params.key,old.rows[0]||null,{value},'SUCCESS');
    await client.query('COMMIT');res.json({key:req.params.key,value});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

app.use(express.static(path.join(__dirname,'../public'),{extensions:['html']}));

app.use((req,res,next)=>{
  if(req.path.startsWith('/api/')) return res.status(404).json({error:'NOT_FOUND'});
  res.sendFile(path.join(__dirname,'../public/index.html'));
});

app.use((err,req,res,_next)=>{
  console.error(JSON.stringify({requestId:requestId(req),error:err.message,code:err.code}));
  const status=err.statusCode||500;
  res.status(status).json({error:status===500?'SERVER_ERROR':err.message});
});

const server=app.listen(port,()=>console.log(`LinkWork listening on ${port}`));
process.on('SIGTERM',()=>server.close(()=>pool.end()));
process.on('SIGINT',()=>server.close(()=>pool.end()));
