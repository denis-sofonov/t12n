export interface NavItem { text: string; link: string }
export interface NavGroup { text: string; items: NavItem[] }

export const sidebars: Record<'en' | 'ru', NavGroup[]> = {
  en: [
    {
      text: 'Introduction',
      items: [{ text: 'Getting started', link: '/guide/getting-started' }],
    },
    {
      text: 'Guide',
      items: [
        { text: 'Boundaries & modes', link: '/guide/boundaries' },
        { text: 'Functions', link: '/guide/functions' },
        { text: 'Live mode', link: '/guide/live-mode' },
        { text: 'Errors & configure', link: '/guide/errors' },
      ],
    },
    {
      text: 'Integrations',
      items: [
        { text: 'Frameworks', link: '/guide/frameworks' },
        { text: 'Vue & Nuxt', link: '/guide/vue' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Core concepts', link: '/guide/concepts' },
        { text: 'The engine', link: '/guide/engine' },
      ],
    },
  ],
  ru: [
    {
      text: 'Введение',
      items: [{ text: 'Начало работы', link: '/ru/guide/getting-started' }],
    },
    {
      text: 'Гайд',
      items: [
        { text: 'Границы и режимы', link: '/ru/guide/boundaries' },
        { text: 'Функции', link: '/ru/guide/functions' },
        { text: 'Live-режим', link: '/ru/guide/live-mode' },
        { text: 'Ошибки и configure', link: '/ru/guide/errors' },
      ],
    },
    {
      text: 'Интеграции',
      items: [
        { text: 'Фреймворки', link: '/ru/guide/frameworks' },
        { text: 'Vue и Nuxt', link: '/ru/guide/vue' },
      ],
    },
    {
      text: 'Концепции',
      items: [
        { text: 'Основные понятия', link: '/ru/guide/concepts' },
        { text: 'Под капотом — движок', link: '/ru/guide/engine' },
      ],
    },
  ],
}

/** UI strings per locale. */
export const ui = {
  en: { onThisPage: 'On this page', prev: 'Previous', next: 'Next', search: 'Search', toGitHub: 'GitHub', menu: 'Menu' },
  ru: { onThisPage: 'На этой странице', prev: 'Назад', next: 'Дальше', search: 'Поиск', toGitHub: 'GitHub', menu: 'Меню' },
}

/** Flatten a sidebar into ordered items for prev / next. */
export function flatten(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((g) => g.items)
}

const norm = (p: string) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p)

/** prev / next neighbours for a given pathname. */
export function neighbours(lang: 'en' | 'ru', pathname: string): { prev?: NavItem; next?: NavItem } {
  const flat = flatten(sidebars[lang])
  const i = flat.findIndex((it) => norm(it.link) === norm(pathname))
  if (i === -1) return {}
  return { prev: flat[i - 1], next: flat[i + 1] }
}

export { norm }
