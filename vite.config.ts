import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	environments: {
		client: {
			build: {
				rollupOptions: {
					input: {
						// The first-run page is a built entry (drive issue #70): its
						// <script type="module"> is bundled from src/get-started.js,
						// which imports the copy from src/status.js. Vite only treats an
						// HTML file as an entry when it is named here (index.html is the
						// implicit default), and the output keeps the entry's own file
						// name, so the page ships at /get-started.html as before. The
						// input is scoped to the client environment: the Worker build's
						// entry stays the src/index.js named in cloudflare.config.ts.
						"get-started": "./get-started.html",
					},
				},
			},
		},
	},
});
