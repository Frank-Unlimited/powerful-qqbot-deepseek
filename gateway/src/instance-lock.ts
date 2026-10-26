import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 同一个 AppID 只能有一条 WebSocket 连接，第二个实例会把第一个挤下线，然后互相重连。
 * 用锁文件保证只跑一个网关；进程已不存在的旧锁会被接管。
 */
export function acquireInstanceLock(path: string) {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'))
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`网关已在运行（PID ${pid}）。如果确认没有在运行，删除 ${path} 后重试`)
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(process.pid))
  const release = () => {
    try {
      if (Number(readFileSync(path, 'utf8')) === process.pid) rmSync(path)
    } catch {}
  }
  process.on('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
