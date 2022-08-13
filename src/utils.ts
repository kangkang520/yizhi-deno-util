export function listenRandom(base: number) {
	const range = 65563 - base;

	const port = parseInt(Math.random() * range + base as any)

	while (true) {
		try {
			const listener = Deno.listen({ port })
			return { port, listener }
		} catch (err) {
			console.error(err)
		}
	}
}

export function fileExists(filename: string) {
	try {
		Deno.statSync(filename)
		return true
	} catch (e) {
		return false
	}
}