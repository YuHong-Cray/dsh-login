// 诊断 dsh-login 注册写库问题：按 /root/.dsh/dsh-login.json 的配置直连 MySQL。
import mysql from 'mysql2/promise'

const CFG = {
  host: '172.19.1.253',
  port: 3306,
  user: 'smart-stp',
  password: 'SmartStp@123',
  database: 'SMART-STP',
  table: 'dsh_login',
}

function step(name) {
  console.log(`\n=== ${name} ===`)
}

step('1. 不带 database 连接, 看数据库列表')
{
  const conn = await mysql.createConnection({ ...CFG, database: undefined, connectTimeout: 8000 })
  try {
    const [dbs] = await conn.query('SHOW DATABASES')
    console.log('databases:', dbs.map((r) => Object.values(r)[0]).join(', '))
    const [grant] = await conn.query('SHOW GRANTS')
    grant.forEach((r) => console.log('grant:', Object.values(r)[0]))
  } finally {
    await conn.end()
  }
}

step(`2. 连接 database=${CFG.database}`)
let conn
try {
  conn = await mysql.createConnection({ ...CFG, connectTimeout: 8000 })
  console.log('connected OK')
} catch (err) {
  console.log('CONNECT FAILED:', err.code, err.errno, err.message)
  process.exit(0)
}

try {
  step('3. 表是否存在')
  const [tables] = await conn.query(`SHOW TABLES LIKE '${CFG.table}'`)
  console.log('tables:', tables.length ? tables.flat() : '(none)')

  if (tables.length) {
    step('4. 现有用户')
    const [rows] = await conn.query(`SELECT id, username, status, model_self_service, created_at, last_login_at FROM \`${CFG.table}\` ORDER BY id`)
    console.table(rows)
  }

  step('5. 写权限测试: INSERT 临时行再 DELETE')
  const probeUser = 'zz_probe_tmp_user'
  try {
    await conn.query(`DELETE FROM \`${CFG.table}\` WHERE username = ?`, [probeUser])
  } catch {
    /* 表不存在或无 DELETE 权限, 忽略 */
  }
  try {
    const [ins] = await conn.query(
      `INSERT INTO \`${CFG.table}\` (username, password_hash, status) VALUES (?, ?, ?)`,
      [probeUser, 'probe-hash', 'pending'],
    )
    console.log('INSERT affectedRows =', ins.affectedRows)
    const [after] = await conn.query(`SELECT username, status FROM \`${CFG.table}\` WHERE username = ?`, [probeUser])
    console.log('read back:', after)
    const [del] = await conn.query(`DELETE FROM \`${CFG.table}\` WHERE username = ?`, [probeUser])
    console.log('cleanup DELETE affectedRows =', del.affectedRows)
  } catch (err) {
    console.log('INSERT FAILED:', err.code, err.errno, err.message)
  }
} finally {
  await conn.end()
}
console.log('\nprobe done')
