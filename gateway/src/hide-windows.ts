import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

/**
 * Windows 上网关在 pm2 后台运行、没有控制台窗口，这时拉起的子进程（dsh 的 node.exe 等）会各自弹出一个黑窗口。
 * dsh SDK 的 spawn 没传 windowsHide，这里把 child_process 的默认值统一改成隐藏窗口，
 * 不用改 node_modules；必须在其他模块拉起子进程之前加载（index.ts 第一行引入）。
 */
if (process.platform === 'win32') {
  const cp = childProcess as any
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const original = cp[name]
    cp[name] = function (this: unknown, ...args: any[]) {
      // 选项对象可能在第 2 或第 3 个参数（exec 的第 2 个可能是回调）
      const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a))
      if (at === -1) {
        const insert = args.findIndex((a, i) => i > 0 && typeof a === 'function')
        if (insert === -1) args.push({ windowsHide: true })
        else args.splice(insert, 0, { windowsHide: true })
      } else if (args[at].windowsHide === undefined) {
        args[at] = { ...args[at], windowsHide: true }
      }
      return original.apply(this, args)
    }
  }
  // ESM 里 import { spawn } from 'node:child_process' 拿到的是同步过的导出，改完要同步一次
  syncBuiltinESMExports()
}
