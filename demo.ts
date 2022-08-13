import { AliPanDriver } from "./aliyun/aliyun.ts"
import { FTPServer } from "./mod.ts"
import { AliyunDriveCommandResolver } from "./src/lib/aliyun.ts"
import { BaseCommandResolver } from "./src/lib/base.ts"

class MyResolver extends AliyunDriveCommandResolver {
	async pass(pass: string) {
		await this._send(230, 'User logged in, proceed.')
	}
}


async function main() {

	const PORT = 3021

	const server = new FTPServer()

	server.on('listen', () => console.log(`Server listen on ${PORT}...`))
	server.on('connection', async conn => {
		const driver = new AliPanDriver()
		await driver.init()
		// await driver.login()

		const resolver = new MyResolver({
			conn, driver,
			debug: true,
		})

		conn.on('error', err => console.error(err))

		//完成
		conn.on('command', async (cmd, opt) => resolver.resolve(cmd, opt))
	})
	server.on('error', err => console.error(err))

	server.listen({ port: PORT })
}

main()