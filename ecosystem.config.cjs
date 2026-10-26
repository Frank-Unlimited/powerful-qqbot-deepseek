// pm2 守护：pm2 start ecosystem.config.cjs；开机自启见 README
module.exports = {
  apps: [{
    name: 'shark-bot',
    cwd: __dirname + '/gateway',
    script: 'node_modules/tsx/dist/cli.mjs',
    args: '--env-file-if-exists=../.env src/index.ts',
    interpreter: 'node',
    // QQ 白名单只填了 IPv4，避免 Node 优先走 IPv6 出口
    node_args: '--dns-result-order=ipv4first',
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 50,
    // dsh 子进程退出时需要几秒刷写会话，别太快强杀
    kill_timeout: 15000,
    out_file: __dirname + '/data/logs/out.log',
    error_file: __dirname + '/data/logs/error.log',
  }],
}
