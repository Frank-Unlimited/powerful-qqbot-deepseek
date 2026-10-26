// 用运行时同一个编译器（esbuild，tsx 底层）把所有源码过一遍：tsc 放过、运行时却编译失败的写法（比如字符串里混进不可见字符）在这里暴露
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
let bad = 0
for (const file of walk('src').filter(f => f.endsWith('.ts'))) {
  try {
    transformSync(readFileSync(file, 'utf8'), { loader: 'ts' })
  } catch (e) {
    bad++
    console.log('FAIL', file, e.message.split('\n')[1] ?? e.message)
  }
}
// 看板页面里的脚本（module 脚本，import 行去掉后按普通 JS 检查语法）
const page = readFileSync('dashboard/index.html', 'utf8')
for (const [, code] of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
  try {
    transformSync(code.replace(/^import .*$/gm, ''), { loader: 'js' })
  } catch (e) {
    bad++
    console.log('FAIL dashboard/index.html', e.message.split('\n')[1] ?? e.message)
  }
}
console.log(bad ? `${bad} 个文件编译失败` : 'esbuild 编译通过（含看板页面）')
process.exit(bad ? 1 : 0)
