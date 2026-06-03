import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
  site: 'https://t12n.vercel.app',
  i18n: {
    locales: ['en', 'ru'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  vite: {
    build: { rollupOptions: { external: ['/pagefind/pagefind.js'] } },
  },
  markdown: {
    shikiConfig: {
      // warm light theme that sits well on the paper palette
      theme: 'vitesse-light',
      wrap: false,
    },
  },
})
