// 扫码绑定 QQ 机器人：用腾讯官方的 qqbot-connector 获取 AppID / AppSecret，写入 ../.env。
// 用法：npm run bind，然后用手机 QQ 扫终端里的二维码（扫不出来就打开打印出的链接）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startQrConnect } from '@tencent-connect/qqbot-connector'
import { ROOT } from '../src/config.js'

const envPath = resolve(ROOT, '.env')

function upsertEnv(values: Record<string, string>) {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(resolve(ROOT, '.env.example'), 'utf8')
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${text.trimEnd()}\n${line}\n`
  }
  writeFileSync(envPath, text)
}

startQrConnect({
  onQrDisplayed(url) {
    console.log(`\n请用手机 QQ 扫描上方二维码；如果显示不全，用手机 QQ 打开这个链接：\n${url}\n`)
  },
  onQrExpired() {
    console.log('二维码过期，正在刷新…')
  },
  onSuccess([credentials]) {
    upsertEnv({ QQ_BOT_ID: credentials.appId, QQ_BOT_SECRET: credentials.appSecret })
    console.log(`绑定成功！AppID ${credentials.appId}，凭据已写入 ${envPath}`)
    process.exit(0)
  },
  onFailure(err) {
    console.error('绑定失败：', err.message)
    process.exit(1)
  },
}, { displayQrCodeToConsole: true })
