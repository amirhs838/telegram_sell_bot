/**
 * Shared bot text templates — pure string helpers with NO server imports,
 * so both the Next.js panel (src/lib/settings.ts, settings UI) and the
 * bot-service (mini-services/bot-service) can use them safely.
 *
 * The welcome message is fully dynamic: the seller edits the template from
 * the admin panel (Setting key «welcomeMessage») and the bot renders it on
 * every /start with the customer's own variables.
 */

/** Placeholders the seller can use inside the welcome template. */
export const WELCOME_VARIABLES = [
  { token: '{name}', hintFa: 'نام کوچک مشتری' },
  { token: '{store}', hintFa: 'نام فروشگاه' },
] as const

/**
 * Default welcome template — reproduces the classic greeting when the seller
 * has not customized anything. «{name}» falls back to «دوست من» for customers
 * whose first name is unknown.
 */
export const DEFAULT_WELCOME_TEMPLATE = [
  'سلام {name}؛',
  'به فروشگاه {store} خوش آمدید 🌸',
  '',
  'برای دیدن محصولات و نمونه‌کارها و ثبت سفارش خرید خود، از منوی پایین صفحه استفاده کنید 👇',
  '',
  '✨ همچنین کافی است سؤال یا درخواست خود را بنویسید تا دستیار فروش ما راهنمایی‌تان کند.',
].join('\n')

export type WelcomeVars = {
  /** customer first name from Telegram (may be empty/undefined) */
  name?: string
  /** store name from Settings (always present) */
  store: string
}

/** Substitute {name} / {store} — unknown placeholders are left untouched. */
export function renderWelcomeTemplate(template: string, vars: WelcomeVars): string {
  const name = vars.name?.trim() || 'دوست من'
  const store = vars.store?.trim() || 'فروشگاه ما'
  return template.replaceAll('{name}', name).replaceAll('{store}', store)
}

/** Build the final welcome text for /start (template + variables). */
export function buildWelcomeMessage(
  template: string | null | undefined,
  vars: WelcomeVars,
): string {
  const tpl = template?.trim() ? template : DEFAULT_WELCOME_TEMPLATE
  return renderWelcomeTemplate(tpl, vars)
}
