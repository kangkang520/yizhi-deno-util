import * as path from 'https://deno.land/std@0.151.0/path/mod.ts'
import { AliPanDriver } from "./libs/aliyun-driver.ts"
import { FTPServer } from "../../ftp-server/server.ts";
import { BaseCommandResolver } from "./libs/base.ts";

class MyResolver extends BaseCommandResolver {
	async pass(pass: string) {
		await this._send(230, 'User logged in, proceed.')
	}
}


async function main() {

	const PORT = 3021

	const server = new FTPServer()

	const driver = new AliPanDriver()
	driver.init()


	server.on('listen', () => console.log(`Server listen on ${PORT}...`))
	server.on('connection', async conn => {
		const resolver = new MyResolver({
			conn,
			debug: true,
			basedir: path.join(Deno.env.get('HOME') ?? '/temp', '.yizhi/cache/aliyun'),
		})

		conn.on('error', err => console.error(err))

		//完成
		conn.on('command', async (cmd, opt) => resolver.resolve(cmd, opt))
	})
	server.on('error', err => console.error(err))

	server.listen({ port: PORT })
}

main()