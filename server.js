import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D, q, validAmount, quoteBuy, quoteSell, cashForQuantity } from './economy.js';

const app = express();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined });
const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'local-development-only');
if (!secret) throw new Error('SESSION_SECRET is required');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM = [['RUSH','CoinRush',2],['NOVA','Nova',4.2],['MOON','Moonshot',.5],['ORBIT','Orbit',1.25],['PIXEL','Pixel',.75],['WAVE','Wave',3.4],['FLUX','Flux',1.8],['SPARK','Spark',.32],['ZEN','Zenith',8.5],['ECHO','Echo',.95]];
const STOCKS = [
 ['SBER','Сбербанк',320,'ru'],['GAZP','Газпром',170,'ru'],['YDEX','Яндекс',4200,'ru'],['LKOH','Лукойл',7100,'ru'],['T','Т-Банк (Т-Технологии)',3300,'ru'],
 ['AAPL','Apple',240,'global'],['MSFT','Microsoft',430,'global'],['NVDA','NVIDIA',145,'global'],['TSLA','Tesla',310,'global'],['GOOGL','Google (Alphabet)',185,'global'],['AMZN','Amazon',210,'global'],['META','Meta',590,'global'],['NFLX','Netflix',880,'global'],['AMD','AMD',160,'global'],['KO','Coca-Cola',65,'global']
];
const num = v => Number(v);
const DecimalMin = (a,b) => D(a).lt(b) ? q(a).toFixed(8) : q(b).toFixed(8);
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const round = v => Math.round((v + Number.EPSILON) * 1e8) / 1e8;
const id = () => crypto.randomUUID();
function sign(value) { return crypto.createHmac('sha256',secret).update(value).digest('hex'); }
function session(req,res,user) { const value = `${user.id}.${Date.now()+30*86400000}`; res.cookie('cr_session',`${value}.${sign(value)}`,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*86400000}); }
async function auth(req,res,next) { try { const parts=req.cookies.cr_session?.split('.'); if(parts?.length===3) {const value=parts.slice(0,2).join('.'); if(crypto.timingSafeEqual(Buffer.from(sign(value)),Buffer.from(parts[2])) && Number(parts[1])>Date.now()) {const q=await pool.query('SELECT id,nickname,email,cash,role,banned,created_at FROM users WHERE id=$1',[parts[0]]); if(q.rows[0]&&!q.rows[0].banned) req.user=q.rows[0];}} next(); } catch { next(); } }
const requireUser=(req,res,next)=>req.user?next():next(fail('Войдите в аккаунт',401));
const requireAdmin=(req,res,next)=>req.user?.role==='admin'?next():next(fail('Нет доступа',403));
async function tx(fn) { const c=await pool.connect(); try {await c.query('BEGIN'); const value=await fn(c); await c.query('COMMIT'); return value;} catch(e){await c.query('ROLLBACK');throw e;} finally {c.release();} }
async function snapshotPortfolio(c,userId){await c.query(`INSERT INTO portfolio_history(user_id,total) SELECT u.id,u.cash+COALESCE(sum(h.amount*coins.pool_cash/coins.pool_tokens),0) FROM users u LEFT JOIN holdings h ON h.user_id=u.id LEFT JOIN coins ON coins.id=h.coin_id WHERE u.id=$1 AND NOT EXISTS(SELECT 1 FROM portfolio_history p WHERE p.user_id=$1 AND p.created_at>now()-interval '5 minutes') GROUP BY u.id`,[userId]);}
async function triggerAlerts(c,coinId,price){await c.query("UPDATE price_alerts SET triggered_at=now() WHERE coin_id=$1 AND triggered_at IS NULL AND ((direction='up' AND target<=$2) OR (direction='down' AND target>=$2))",[coinId,price]);}
async function init(){
 await pool.query(`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,nickname text UNIQUE NOT NULL,email text UNIQUE NOT NULL,password_hash text NOT NULL,cash numeric(24,8) NOT NULL DEFAULT 1000,role text NOT NULL DEFAULT 'user',banned boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS coins(id uuid PRIMARY KEY,ticker text UNIQUE NOT NULL,name text NOT NULL,description text NOT NULL DEFAULT '',logo text NOT NULL DEFAULT '',creator_id uuid REFERENCES users(id),supply numeric(24,8) NOT NULL,pool_cash numeric(24,8) NOT NULL,pool_tokens numeric(24,8) NOT NULL,initial_price numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS holdings(user_id uuid REFERENCES users(id),coin_id uuid REFERENCES coins(id),amount numeric(24,8) NOT NULL DEFAULT 0,PRIMARY KEY(user_id,coin_id));
 CREATE TABLE IF NOT EXISTS trades(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),coin_id uuid REFERENCES coins(id),side text NOT NULL,amount numeric(24,8) NOT NULL,cash numeric(24,8) NOT NULL,price numeric(24,8) NOT NULL,fee numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS transfers(id uuid PRIMARY KEY,sender_id uuid REFERENCES users(id),recipient_id uuid REFERENCES users(id),coin_id uuid REFERENCES coins(id),amount numeric(24,8) NOT NULL,fee numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS news(id uuid PRIMARY KEY,body text NOT NULL,kind text NOT NULL DEFAULT 'market',coin_id uuid REFERENCES coins(id),created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS price_history(id bigserial PRIMARY KEY,coin_id uuid REFERENCES coins(id),price numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value text NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_log(id uuid PRIMARY KEY,admin_id uuid REFERENCES users(id),action text NOT NULL,details text NOT NULL,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS bot_accounts(id uuid PRIMARY KEY,name text UNIQUE NOT NULL,kind text NOT NULL,cash numeric(24,8) NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_holdings(bot_id uuid REFERENCES bot_accounts(id),coin_id uuid REFERENCES coins(id),amount numeric(24,8) NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,coin_id));
 CREATE INDEX IF NOT EXISTS price_history_coin_time ON price_history(coin_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS trades_coin_time ON trades(coin_id,created_at DESC);`);
 await pool.query("ALTER TABLE coins ADD COLUMN IF NOT EXISTS asset_kind text NOT NULL DEFAULT 'token'");
 await pool.query('ALTER TABLE coins ADD COLUMN IF NOT EXISTS region text');
 await pool.query('ALTER TABLE coins ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true');
 await pool.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS request_key uuid');
 await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS initial_cash numeric(24,8) NOT NULL DEFAULT 1000');
 await pool.query('ALTER TABLE holdings ADD COLUMN IF NOT EXISTS cost_basis numeric(24,8)');
 await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS trades_request_key ON trades(user_id,request_key) WHERE request_key IS NOT NULL');
 await pool.query(`CREATE TABLE IF NOT EXISTS bot_trades(id uuid PRIMARY KEY,bot_id uuid REFERENCES bot_accounts(id),coin_id uuid REFERENCES coins(id),side text NOT NULL,amount numeric(24,8) NOT NULL,cash numeric(24,8) NOT NULL,price numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());CREATE INDEX IF NOT EXISTS bot_trades_coin_time ON bot_trades(coin_id,created_at DESC)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_history(id bigserial PRIMARY KEY,user_id uuid REFERENCES users(id),total numeric(24,8) NOT NULL,created_at timestamptz DEFAULT now());CREATE INDEX IF NOT EXISTS portfolio_history_user_time ON portfolio_history(user_id,created_at DESC);CREATE TABLE IF NOT EXISTS favorites(user_id uuid REFERENCES users(id),coin_id uuid REFERENCES coins(id),PRIMARY KEY(user_id,coin_id));CREATE TABLE IF NOT EXISTS price_alerts(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),coin_id uuid REFERENCES coins(id),target numeric(24,8) NOT NULL,direction text NOT NULL,triggered_at timestamptz,created_at timestamptz DEFAULT now())`);
 await pool.query("UPDATE coins SET is_active=false WHERE creator_id IS NULL AND ticker=ANY($1::text[])",[SYSTEM.map(s=>s[0])]);
 for(const [ticker,name,price,region] of STOCKS){const coinId=id(); const q=await pool.query(`INSERT INTO coins(id,ticker,name,description,logo,supply,pool_cash,pool_tokens,initial_price,asset_kind,region) VALUES($1,$2,$3,$4,$5,1000000,$6,100000,$7,'stock',$8) ON CONFLICT(ticker) DO UPDATE SET name=EXCLUDED.name,asset_kind='stock',region=EXCLUDED.region,is_active=true RETURNING id`,[coinId,ticker,name,'Игровая акция. Цена не связана с реальной биржей.',ticker[0],price*100000,price,region]);await pool.query('INSERT INTO price_history(coin_id,price) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM price_history WHERE coin_id=$1)',[q.rows[0].id,price]);}
 for(const [name,kind,cash] of [['Новичок','novice',5000],['Скальпер','scalper',20000],['Инвестор','investor',30000],['Паникёр','panic',12000],['Криптокит','whale',250000],['Китайские скупщики','group',100000]]) await pool.query('INSERT INTO bot_accounts(id,name,kind,cash) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING',[id(),name,kind,cash]);
 await pool.query("INSERT INTO settings(key,value) VALUES('market_mode','sideways'),('bot_enabled','true'),('bot_frequency','1'),('starting_cash','1000'),('listing_fee','250') ON CONFLICT DO NOTHING");
 if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){const email=process.env.ADMIN_EMAIL.toLowerCase().trim();const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);await pool.query('INSERT INTO users(id,nickname,email,password_hash,cash,role) VALUES($1,$2,$3,$4,1000,\'admin\') ON CONFLICT(email) DO UPDATE SET role=\'admin\'',[id(),'Admin',email,hash]);}
}
app.use(express.json({limit:'100kb'})); app.use(cookieParser()); app.use(auth); app.use(express.static(path.join(ROOT,'public')));
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.post('/api/register',async(req,res,next)=>{try{const nickname=String(req.body.nickname||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname)||!/^\S+@\S+\.\S+$/.test(email)||password.length<8)throw fail('Проверьте ник, email и пароль (от 8 символов)');const hash=await bcrypt.hash(password,12);const starting=num((await pool.query("SELECT value FROM settings WHERE key='starting_cash'")).rows[0].value);const q=await pool.query('INSERT INTO users(id,nickname,email,password_hash,cash,initial_cash) VALUES($1,$2,$3,$4,$5,$5) RETURNING id,nickname,email,cash,role',[id(),nickname,email,hash,starting]);session(req,res,q.rows[0]);res.json(q.rows[0]);}catch(e){next(e.code==='23505'?fail('Ник или email уже занят'):e);}});
app.post('/api/login',async(req,res,next)=>{try{const q=await pool.query('SELECT * FROM users WHERE email=$1',[String(req.body.email||'').toLowerCase().trim()]);const u=q.rows[0];if(!u||!(await bcrypt.compare(String(req.body.password||''),u.password_hash)))throw fail('Неверный email или пароль',401);if(u.banned)throw fail('Аккаунт заблокирован',403);session(req,res,u);res.json({id:u.id,nickname:u.nickname,email:u.email,cash:u.cash,role:u.role});}catch(e){next(e);}});
app.post('/api/logout',(req,res)=>{res.clearCookie('cr_session');res.json({ok:true});});
app.get('/api/me',(req,res)=>res.json(req.user||null));
app.get('/api/market',async(req,res,next)=>{try{const [coins,settings,news]=await Promise.all([pool.query(`SELECT c.*,COALESCE((SELECT price FROM price_history h WHERE h.coin_id=c.id AND h.created_at<=now()-interval '24 hours' ORDER BY h.created_at DESC LIMIT 1),c.initial_price) old_price,(SELECT count(*) FROM holdings h WHERE h.coin_id=c.id AND h.amount>0) holders,(SELECT COALESCE(sum(cash),0) FROM (SELECT cash,created_at FROM trades WHERE coin_id=c.id UNION ALL SELECT cash,created_at FROM bot_trades WHERE coin_id=c.id) t WHERE t.created_at>now()-interval '24 hours') volume FROM coins c WHERE c.is_active=true ORDER BY CASE WHEN c.region='ru' THEN 0 WHEN c.region='global' THEN 1 ELSE 2 END,c.created_at,c.ticker`),pool.query('SELECT * FROM settings'),pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 20')]);const sparkRows=await pool.query("SELECT coin_id,price FROM (SELECT coin_id,price,created_at,row_number() OVER(PARTITION BY coin_id ORDER BY created_at DESC) rn FROM price_history) x WHERE rn<=24 ORDER BY coin_id,created_at");const sparkMap=new Map();for(const row of sparkRows.rows){const values=sparkMap.get(row.coin_id)||[];values.push(Number(row.price));sparkMap.set(row.coin_id,values);}res.json({coins:coins.rows.map(c=>({...c,sparkline:sparkMap.get(c.id)||[],price:round(num(c.pool_cash)/num(c.pool_tokens)),change:round((num(c.pool_cash)/num(c.pool_tokens)/num(c.old_price)-1)*100),market_cap:round(num(c.supply)*num(c.pool_cash)/num(c.pool_tokens))})),settings:Object.fromEntries(settings.rows.map(s=>[s.key,s.value])),news:news.rows});}catch(e){next(e);}});
app.get('/api/coin/:id',async(req,res,next)=>{try{
 const [history,trades,coin,day]=await Promise.all([
  pool.query('SELECT price,created_at FROM price_history WHERE coin_id=$1 ORDER BY created_at DESC LIMIT 5000',[req.params.id]),
  pool.query(`SELECT * FROM (SELECT t.side,t.amount,t.cash,t.price,t.created_at,u.nickname actor,'player' actor_type FROM trades t JOIN users u ON u.id=t.user_id WHERE t.coin_id=$1 UNION ALL SELECT t.side,t.amount,t.cash,t.price,t.created_at,b.name actor,'bot' actor_type FROM bot_trades t JOIN bot_accounts b ON b.id=t.bot_id WHERE t.coin_id=$1) x ORDER BY created_at DESC LIMIT 80`,[req.params.id]),
  pool.query('SELECT id,pool_cash,pool_tokens FROM coins WHERE id=$1',[req.params.id]),
  pool.query("SELECT min(price) low,max(price) high FROM price_history WHERE coin_id=$1 AND created_at>now()-interval '24 hours'",[req.params.id])
 ]);
 if(!coin.rows[0])throw fail('Актив не найден',404);
 res.json({history:history.rows.reverse(),trades:trades.rows,day:day.rows[0],pool:{cash:coin.rows[0].pool_cash,tokens:coin.rows[0].pool_tokens}});
}catch(e){next(e);}});
app.get('/api/wallet',requireUser,async(req,res,next)=>{try{const [holdings,trades,transfers,tokens]=await Promise.all([pool.query('SELECT h.*,c.ticker,c.name,c.asset_kind,c.is_active,c.pool_cash/c.pool_tokens price FROM holdings h JOIN coins c ON c.id=h.coin_id WHERE h.user_id=$1 AND h.amount>0 ORDER BY h.amount*c.pool_cash/c.pool_tokens DESC',[req.user.id]),pool.query('SELECT t.*,c.ticker FROM trades t JOIN coins c ON c.id=t.coin_id WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 50',[req.user.id]),pool.query('SELECT t.*,c.ticker,s.nickname sender,r.nickname recipient FROM transfers t JOIN coins c ON c.id=t.coin_id JOIN users s ON s.id=t.sender_id JOIN users r ON r.id=t.recipient_id WHERE t.sender_id=$1 OR t.recipient_id=$1 ORDER BY t.created_at DESC LIMIT 30',[req.user.id]),pool.query('SELECT id,ticker,name FROM coins WHERE creator_id=$1',[req.user.id])]);const user=(await pool.query('SELECT cash,initial_cash FROM users WHERE id=$1',[req.user.id])).rows[0];
const total=q(holdings.rows.reduce((sum,h)=>sum.plus(D(h.amount).mul(h.price)),D(user.cash))).toFixed(8);
await snapshotPortfolio(pool,req.user.id);
const [history,dayBase,favorites,alerts]=await Promise.all([
 pool.query('SELECT total,created_at FROM portfolio_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',[req.user.id]),
 pool.query("SELECT total FROM portfolio_history WHERE user_id=$1 AND created_at<=now()-interval '24 hours' ORDER BY created_at DESC LIMIT 1",[req.user.id]),
 pool.query('SELECT coin_id FROM favorites WHERE user_id=$1',[req.user.id]),
 pool.query('SELECT a.*,c.ticker FROM price_alerts a JOIN coins c ON c.id=a.coin_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 30',[req.user.id])
]);
res.json({cash:user.cash,holdings:holdings.rows,trades:trades.rows,transfers:transfers.rows,tokens:tokens.rows,total,profitAll:q(D(total).minus(user.initial_cash)).toFixed(8),profit24h:dayBase.rows[0]?q(D(total).minus(dayBase.rows[0].total)).toFixed(8):null,history:history.rows.reverse(),favorites:favorites.rows.map(f=>f.coin_id),alerts:alerts.rows});}catch(e){next(e);}});
app.post('/api/favorites',requireUser,async(req,res,next)=>{try{const coinId=String(req.body.coinId||'');const coin=(await pool.query('SELECT id FROM coins WHERE id=$1 AND is_active=true',[coinId])).rows[0];if(!coin)throw fail('Актив не найден',404);const deleted=await pool.query('DELETE FROM favorites WHERE user_id=$1 AND coin_id=$2 RETURNING coin_id',[req.user.id,coinId]);if(!deleted.rowCount)await pool.query('INSERT INTO favorites(user_id,coin_id) VALUES($1,$2)',[req.user.id,coinId]);res.json({favorite:!deleted.rowCount});}catch(e){next(e);}});
app.post('/api/alerts',requireUser,async(req,res,next)=>{try{const {coinId,direction}=req.body,target=req.body.target;if(!validAmount(target)||!['up','down'].includes(direction))throw fail('Некорректное уведомление');const coin=(await pool.query('SELECT pool_cash/pool_tokens price FROM coins WHERE id=$1 AND is_active=true',[coinId])).rows[0];if(!coin)throw fail('Актив не найден',404);if(direction==='up'&&D(target).lte(coin.price)||direction==='down'&&D(target).gte(coin.price))throw fail('Укажите цену выше или ниже текущей');await pool.query('INSERT INTO price_alerts(id,user_id,coin_id,target,direction) VALUES($1,$2,$3,$4,$5)',[id(),req.user.id,coinId,q(target).toFixed(8),direction]);res.json({ok:true});}catch(e){next(e);}});
app.post('/api/quote',async(req,res,next)=>{try{
 const {side,coinId,mode=side==='buy'?'cash':'quantity'}=req.body,amount=req.body.amount;
 if(!['buy','sell'].includes(side)||!validAmount(amount))throw fail('Некорректная сумма');
 const coin=(await pool.query('SELECT * FROM coins WHERE id=$1',[coinId])).rows[0];if(!coin||!coin.is_active)throw fail('Актив не найден',404);
 const spend=side==='buy'&&mode==='quantity'?cashForQuantity(coin.pool_cash,coin.pool_tokens,amount):amount;
 const quote=side==='buy'?quoteBuy(coin.pool_cash,coin.pool_tokens,spend):quoteSell(coin.pool_cash,coin.pool_tokens,amount);
 res.json({...quote,price:q(D(quote.nextCash).div(quote.nextTokens)).toFixed(8),currentPrice:q(D(coin.pool_cash).div(coin.pool_tokens)).toFixed(8)});
}catch(e){next(e.status?e:fail(e.message));}});
app.post('/api/trade',requireUser,async(req,res,next)=>{try{
 const {side,coinId,mode=side==='buy'?'cash':'quantity',requestKey}=req.body,amount=req.body.amount;
 if(!['buy','sell'].includes(side)||!validAmount(amount)||!['cash','quantity'].includes(mode)||side==='sell'&&mode!=='quantity')throw fail('Некорректная сделка');
 if(requestKey&&!/^[0-9a-f-]{36}$/i.test(requestKey))throw fail('Некорректный ключ запроса');
 if(requestKey){const previous=(await pool.query('SELECT side,amount,cash,price,fee FROM trades WHERE user_id=$1 AND request_key=$2',[req.user.id,requestKey])).rows[0];if(previous){res.json(previous);return;}}
 const result=await tx(async c=>{
  const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
  if(requestKey){const previous=(await c.query('SELECT side,amount,cash,price,fee FROM trades WHERE user_id=$1 AND request_key=$2',[u.id,requestKey])).rows[0];if(previous)return previous;}
  const coin=(await c.query('SELECT * FROM coins WHERE id=$1 FOR UPDATE',[coinId])).rows[0];if(!coin)throw fail('Актив не найден',404);
  if(!coin.is_active&&side==='buy')throw fail('Актив больше не торгуется');
  const spend=side==='buy'&&mode==='quantity'?cashForQuantity(coin.pool_cash,coin.pool_tokens,amount):amount;
  if(!validAmount(spend))throw fail('Сумма слишком велика');
  const quote=side==='buy'?quoteBuy(coin.pool_cash,coin.pool_tokens,spend):quoteSell(coin.pool_cash,coin.pool_tokens,amount);
  if(side==='buy'){
   if(D(u.cash).lt(quote.cash))throw fail('Недостаточно игровых долларов');
   await c.query('UPDATE users SET cash=cash-$1 WHERE id=$2',[quote.cash,u.id]);
   const execution=q(D(quote.cash).div(quote.quantity)).toFixed(8);
   await c.query('INSERT INTO holdings(user_id,coin_id,amount,cost_basis) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,coin_id) DO UPDATE SET cost_basis=CASE WHEN holdings.cost_basis IS NULL AND holdings.amount>0 THEN NULL ELSE (COALESCE(holdings.cost_basis,0)*holdings.amount+$3*$4)/(holdings.amount+$3) END,amount=holdings.amount+$3',[u.id,coinId,quote.quantity,execution]);
  }else{
   const holding=(await c.query('SELECT amount FROM holdings WHERE user_id=$1 AND coin_id=$2 FOR UPDATE',[u.id,coinId])).rows[0];
   if(!holding||D(holding.amount).lt(quote.quantity))throw fail('Недостаточно активов');
   await c.query('UPDATE users SET cash=cash+$1 WHERE id=$2',[quote.cash,u.id]);
   await c.query('UPDATE holdings SET amount=amount-$1 WHERE user_id=$2 AND coin_id=$3',[quote.quantity,u.id,coinId]);
  }
  await c.query('UPDATE coins SET pool_cash=$1,pool_tokens=$2 WHERE id=$3',[quote.nextCash,quote.nextTokens,coinId]);
  const price=q(D(quote.nextCash).div(quote.nextTokens)).toFixed(8);
  await c.query('INSERT INTO trades(id,user_id,coin_id,side,amount,cash,price,fee,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id(),u.id,coinId,side,quote.quantity,quote.cash,price,quote.fee,requestKey||null]);
  await c.query('INSERT INTO price_history(coin_id,price) VALUES($1,$2)',[coinId,price]);
  await triggerAlerts(c,coinId,price);
  return {side,amount:quote.quantity,cash:quote.cash,price,fee:quote.fee};
 });res.json(result);
}catch(e){next(e.status?e:fail(e.message));}});
app.post('/api/tokens',requireUser,async(req,res,next)=>{try{
 const name=String(req.body.name||'').trim(),ticker=String(req.body.ticker||'').trim().toUpperCase(),description=String(req.body.description||'').trim(),logo=String(req.body.logo||'').trim();
 const supply=Number(req.body.supply),liquidity=req.body.liquidity;
 if(name.length<3||name.length>40||!/^[A-Z0-9]{2,8}$/.test(ticker)||description.length>500||logo.length>4||!Number.isSafeInteger(supply)||supply<100||supply>1e9||!validAmount(liquidity,'100000000')||D(liquidity).lt(100))throw fail('Проверьте параметры токена');
 const result=await tx(async c=>{
  const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
  const fee=D((await c.query("SELECT value FROM settings WHERE key='listing_fee'")).rows[0].value);
  const total=q(fee.plus(liquidity));if(D(u.cash).lt(total))throw fail('Недостаточно средств для листинга и ликвидности');
  const coinId=id(),poolTokens=D(supply).div(2),initialPrice=q(D(liquidity).div(poolTokens)).toFixed(8);
  if(!D(initialPrice).gt(0))throw fail('Начальная цена слишком мала');
  await c.query('UPDATE users SET cash=cash-$1 WHERE id=$2',[total.toFixed(8),u.id]);
  await c.query('INSERT INTO coins(id,ticker,name,description,logo,creator_id,supply,pool_cash,pool_tokens,initial_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[coinId,ticker,name,description,logo||ticker[0],u.id,supply,q(liquidity).toFixed(8),poolTokens.toFixed(8),initialPrice]);
  await c.query('INSERT INTO holdings(user_id,coin_id,amount) VALUES($1,$2,$3)',[u.id,coinId,poolTokens.toFixed(8)]);
  await c.query('INSERT INTO price_history(coin_id,price) VALUES($1,$2)',[coinId,initialPrice]);
  await c.query('INSERT INTO news(id,body,kind,coin_id) VALUES($1,$2,$3,$4)',[id(),`Новый токен ${ticker} вышел на игровую биржу`,'listing',coinId]);
  return {id:coinId,ticker};
 });res.json(result);
}catch(e){next(e.code==='23505'?fail('Этот тикер уже занят'):e);}});
app.post('/api/transfer',requireUser,async(req,res,next)=>{try{
 const recipient=String(req.body.recipient||'').trim(),coinId=String(req.body.coinId||''),amount=req.body.amount;
 if(!validAmount(amount))throw fail('Некорректное количество');
 const result=await tx(async c=>{
  const r=(await c.query('SELECT id FROM users WHERE nickname=$1 OR id::text=$1',[recipient])).rows[0];
  if(!r||r.id===req.user.id)throw fail('Получатель не найден');
  const h=(await c.query('SELECT amount,cost_basis FROM holdings WHERE user_id=$1 AND coin_id=$2 FOR UPDATE',[req.user.id,coinId])).rows[0];
  if(!h||D(h.amount).lt(amount))throw fail('Недостаточно активов');
  const fee=q(D(amount).mul('0.005')).toFixed(8),received=q(D(amount).minus(fee)).toFixed(8);
  if(!D(received).gt(0))throw fail('Сумма перевода слишком мала');
  await c.query('UPDATE holdings SET amount=amount-$1 WHERE user_id=$2 AND coin_id=$3',[amount,req.user.id,coinId]);
  await c.query('INSERT INTO holdings(user_id,coin_id,amount,cost_basis) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,coin_id) DO UPDATE SET cost_basis=CASE WHEN holdings.cost_basis IS NULL OR EXCLUDED.cost_basis IS NULL THEN NULL ELSE (holdings.cost_basis*holdings.amount+EXCLUDED.cost_basis*$3)/(holdings.amount+$3) END,amount=holdings.amount+$3',[r.id,coinId,received,h.cost_basis]);
  await c.query('INSERT INTO transfers(id,sender_id,recipient_id,coin_id,amount,fee) VALUES($1,$2,$3,$4,$5,$6)',[id(),req.user.id,r.id,coinId,amount,fee]);
  return {received,fee};
 });res.json(result);
}catch(e){next(e);}});
app.get('/api/leaderboard',async(req,res,next)=>{try{const q=await pool.query(`SELECT u.id,u.nickname,u.cash,COALESCE(h.assets,0) assets,COALESCE(t.trades,0) trades,COALESCE(o.tokens,0) tokens FROM users u LEFT JOIN (SELECT h.user_id,sum(h.amount*c.pool_cash/c.pool_tokens) assets FROM holdings h JOIN coins c ON c.id=h.coin_id GROUP BY h.user_id) h ON h.user_id=u.id LEFT JOIN (SELECT user_id,count(*) trades FROM trades GROUP BY user_id) t ON t.user_id=u.id LEFT JOIN (SELECT creator_id,count(*) tokens FROM coins WHERE creator_id IS NOT NULL GROUP BY creator_id) o ON o.creator_id=u.id WHERE u.banned=false ORDER BY u.cash+COALESCE(h.assets,0) DESC LIMIT 50`);res.json(q.rows);}catch(e){next(e);}});
app.get('/api/whales',async(req,res,next)=>{try{const q=await pool.query(`SELECT t.side,t.amount,t.cash,t.price,t.created_at,c.ticker,u.nickname FROM trades t JOIN coins c ON c.id=t.coin_id JOIN users u ON u.id=t.user_id WHERE t.cash>=100 ORDER BY t.created_at DESC LIMIT 50`);res.json(q.rows);}catch(e){next(e);}});
app.get('/api/admin',requireAdmin,async(req,res,next)=>{try{const [users,settings,log]=await Promise.all([pool.query('SELECT id,nickname,email,cash,role,banned,created_at FROM users ORDER BY created_at DESC LIMIT 100'),pool.query('SELECT * FROM settings'),pool.query('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 50')]);res.json({users:users.rows,settings:Object.fromEntries(settings.rows.map(s=>[s.key,s.value])),log:log.rows});}catch(e){next(e);}});
app.post('/api/admin',requireAdmin,async(req,res,next)=>{try{const {action,target,value}=req.body;await tx(async c=>{if(action==='cash'){const n=num(value);if(!Number.isFinite(n)||Math.abs(n)>1e7)throw fail('Некорректная сумма');const q=await c.query('UPDATE users SET cash=cash+$1 WHERE id=$2 AND cash+$1>=0 RETURNING id',[n,target]);if(!q.rowCount)throw fail('Игрок не найден или баланс станет отрицательным');}else if(action==='ban'){const q=await c.query('UPDATE users SET banned=$1 WHERE id=$2 AND id<>$3 RETURNING id',[Boolean(value),target,req.user.id]);if(!q.rowCount)throw fail('Игрок не найден');}else if(action==='setting'){if(!['market_mode','bot_enabled','bot_frequency','starting_cash','listing_fee'].includes(target))throw fail('Неизвестная настройка');let v=String(value);if(target==='market_mode'&&!['bull','bear','sideways'].includes(v))throw fail('Некорректный режим');if(target==='bot_enabled'&&!['true','false'].includes(v))throw fail('Некорректное значение');if(['bot_frequency','starting_cash','listing_fee'].includes(target)&&(!Number.isFinite(num(v))||num(v)<0||num(v)>1e6))throw fail('Некорректное значение');await c.query('UPDATE settings SET value=$1 WHERE key=$2',[v,target]);}else if(action==='news'){const body=String(value||'').trim();if(!body||body.length>240)throw fail('Введите новость до 240 символов');await c.query('INSERT INTO news(id,body,kind) VALUES($1,$2,$3)',[id(),body,'admin']);}else throw fail('Неизвестное действие');await c.query('INSERT INTO admin_log(id,admin_id,action,details) VALUES($1,$2,$3,$4)',[id(),req.user.id,action,JSON.stringify({target,value})]);});res.json({ok:true});}catch(e){next(e);}});
let botBusy=false;
async function botTick(){
 if(botBusy)return;botBusy=true;
 try{
  const settings=Object.fromEntries((await pool.query('SELECT * FROM settings')).rows.map(s=>[s.key,s.value]));
  if(settings.bot_enabled!=='true'||Math.random()>Math.min(1,num(settings.bot_frequency)))return;
  const bot=(await pool.query('SELECT id FROM bot_accounts ORDER BY random() LIMIT 1')).rows[0];
  const coin=(await pool.query('SELECT id FROM coins WHERE is_active=true ORDER BY random() LIMIT 1')).rows[0];
  if(!bot||!coin)return;
  await tx(async c=>{
   const b=(await c.query('SELECT * FROM bot_accounts WHERE id=$1 FOR UPDATE',[bot.id])).rows[0];
   const row=(await c.query('SELECT * FROM coins WHERE id=$1 FOR UPDATE',[coin.id])).rows[0];
   const holding=(await c.query('SELECT amount FROM bot_holdings WHERE bot_id=$1 AND coin_id=$2 FOR UPDATE',[b.id,row.id])).rows[0];
   const buy=Math.random()<(settings.market_mode==='bull'?.68:settings.market_mode==='bear'?.32:.5);
   const fraction=b.kind==='whale'?.06:b.kind==='group'?.035:.001+Math.random()*.008;
   const desired=buy?q(D(row.pool_cash).mul(fraction)):q(D(row.pool_tokens).mul(fraction));
   const amount=buy?DecimalMin(desired,b.cash):DecimalMin(desired,holding?.amount||0);
   if(!validAmount(amount)||D(amount).lt('0.01'))return;
   const quote=buy?quoteBuy(row.pool_cash,row.pool_tokens,amount):quoteSell(row.pool_cash,row.pool_tokens,amount);
   if(buy){await c.query('UPDATE bot_accounts SET cash=cash-$1 WHERE id=$2',[quote.cash,b.id]);await c.query('INSERT INTO bot_holdings(bot_id,coin_id,amount) VALUES($1,$2,$3) ON CONFLICT(bot_id,coin_id) DO UPDATE SET amount=bot_holdings.amount+$3',[b.id,row.id,quote.quantity]);}
   else{await c.query('UPDATE bot_accounts SET cash=cash+$1 WHERE id=$2',[quote.cash,b.id]);await c.query('UPDATE bot_holdings SET amount=amount-$1 WHERE bot_id=$2 AND coin_id=$3',[quote.quantity,b.id,row.id]);}
   await c.query('UPDATE coins SET pool_cash=$1,pool_tokens=$2 WHERE id=$3',[quote.nextCash,quote.nextTokens,row.id]);
   const price=q(D(quote.nextCash).div(quote.nextTokens)).toFixed(8);
   await c.query('INSERT INTO price_history(coin_id,price) VALUES($1,$2)',[row.id,price]);
   await triggerAlerts(c,row.id,price);
   await c.query('INSERT INTO bot_trades(id,bot_id,coin_id,side,amount,cash,price) VALUES($1,$2,$3,$4,$5,$6,$7)',[id(),b.id,row.id,buy?'buy':'sell',quote.quantity,quote.cash,price]);
   if(['whale','group'].includes(b.kind))await c.query('INSERT INTO news(id,body,kind,coin_id) VALUES($1,$2,$3,$4)',[id(),`${b.name} ${buy?'покупают':'продают'} ${row.ticker} на игровой бирже`,b.kind,row.id]);
  });
  if(Math.random()<.01){const next=['bull','bear','sideways'][Math.floor(Math.random()*3)];await pool.query("UPDATE settings SET value=$1 WHERE key='market_mode'",[next]);await pool.query('INSERT INTO news(id,body,kind) VALUES($1,$2,$3)',[id(),`Режим рынка изменился: ${next==='bull'?'бычий':next==='bear'?'медвежий':'боковой'}`,'market']);}
 }catch(e){console.error('Bot tick:',e.message);}finally{botBusy=false;}
}
app.use((e,req,res,next)=>{console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Ошибка сервера'});});
await init();setInterval(botTick,15000).unref();app.listen(process.env.PORT||3000,()=>console.log(`CoinRush running on ${process.env.PORT||3000}`));
