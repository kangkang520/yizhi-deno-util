# ftp-server

Use to create a FTP server

## Usage

1. Create a class to resolve FTP commands.

   There are many examples under `demo` folder.

1. Create FTP server
   ```ts
   const server = new FTPServer();
   ```

1. Add `connection` event listener to accept connection
   ```ts
   server.on("connection", async (conn) => {
     const resolver = new MyResolver({
       conn,
       debug: true,
	   //... more
     });

     conn.on("error", (err) => console.error(err));

     //resolve command
     conn.on("command", (cmd, opt) => resolver.resolve(cmd, opt));
   });
   ```
1. Listen.
	```ts
	server.listen({ port: 21 })
	```