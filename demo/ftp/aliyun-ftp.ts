/**
 * TO build this util, run
 * 
 * 		deno compile --allow-all --unstable demo/ftp/aliyun-ftp.ts
 * 
 */

import { AliPanDriver } from "./libs/aliyun-driver.ts"
import { FTPServer } from "../../ftp-server/server.ts";
import { AliyunDriveCommandResolver } from "./libs/aliyun.ts"

interface IAliPanFTPOption {
	listen?: number
}

class MyResolver extends AliyunDriveCommandResolver {
	async pass(pass: string) {
		await this._send(230, 'User logged in, proceed.')
	}
}


async function start(option?: IAliPanFTPOption) {

	const { listen = 3021 } = option ?? {}

	const server = new FTPServer()

	const driver = new AliPanDriver()
	driver.init()


	server.on('listen', () => console.log(`Server listen on ${listen}...`))
	server.on('connection', async conn => {
		// await driver.login()

		const resolver = new MyResolver({
			conn, driver,
			debug: true,
			// cachedir: path.join(Deno.env.get('HOME') ?? '/temp', '.yizhi/cache/aliyun'),
		})

		conn.on('error', err => console.error(err))

		//完成
		conn.on('command', async (cmd, opt) => resolver.resolve(cmd, opt))
	})
	server.on('error', err => console.error(err))

	server.listen({ port: listen })
}


async function main() {
	const args = Deno.args

	const options: any = {}

	try {
		for (let i = 0; i < args.length; ++i) {
			const arg = args[i]
			let key: string | null = null
			let val: string | null = null
			if (arg.startsWith('--listen=')) {
				key = 'listen'
				const match = arg.match(/^--listen=(\d+)$/)
				val = match?.[1] ?? null
			}
			else if (arg == '-l') {
				key = 'listen'
				val = args[i + 1]
			}
			else if (arg.startsWith('-l')) {
				key = 'listen'
				val = arg.slice(2)
			}
			else if (arg == '--help' || arg == '-h') {
				key = 'help'
				val = ''
			}

			if (key == 'listen') {
				if (!val || !/^\d+$/.test(val)) throw new Error('listen option need a int number')
				let port = parseInt(val)
				if (port <= 0 || port >= 65535) continue
				options[key] = port
			}
			else if (key == 'help') {
				options.help = true
			}
		}
		if (options.help) throw new Error('xx')
	} catch (err) {
		console.log([
			`USAGE:`,
			`    aliyun-ftp [OPTIONS]`,
			``,
			`OPTIONS`,
			`    -h, --help`,
			`        Print this information`,
			``,
			`    -l, --listen=<PORT>`,
			`        Set FTP server port`,
			``,
		].join('\n'))
		return
	}

	start(options)
}

main()