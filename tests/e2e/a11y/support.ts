/**
 * Shared helpers for the Stage 10 accessibility and responsive specs (owner: e2e-a11y): themes, axe scans, keyboard
 * walks, layout probes and the DB-backed page data (recordings, email tokens, account invites) that the pages need.
 *
 *   await useTheme(context, 'dark')
 *   await page.goto('/login')
 *   await expectAccessible(page, 'login (dark)')
 *
 * axe runs with the WCAG 2.x A/AA tags and fails on `serious` and `critical` violations only; every result is attached
 * to the report. A rule switched off for one scan must name its pending finding (`pending: { rule: 'finding' }`).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/postgres-js'
import { emailTokens, recordings, userInvites, users } from '../../../server/database/schema'
import { hashToken, randomToken } from '../../../server/utils/crypto'
import { expect, test } from '../fixtures'
import type { Guards, Secrets } from '../fixtures/base'
import type { E2eRoom, E2eUser, JoinResult, RoomsFixture } from '../fixtures/join'
import { waitForPhase } from '../fixtures/livekit'

export { expect, test }

export type E2eDb = ReturnType<typeof drizzle>

// ---- Findings -----------------------------------------------------------------------------------------------------

/**
 * Product defects these specs found (Stage 10, reported to the orchestrator for the Findings list). Every place that
 * works around one carries a `// pending finding:` comment and uses the summary below; the fix agent deletes the entry
 * and its uses, which turns the full check back on.
 */
export const PENDING = {
  chatList:
    'pending finding: chat messages are <li> inside <ol role="log">, which drops the list semantics (ChatPanel)',
  destructiveContrast:
    'pending finding: destructive buttons in the dark theme are 4.42:1 (#f66c6d on #432c33), under 4.5:1',
  sessionsList: 'pending finding: the session list has role="list" but its items have no role="listitem" (SessionList)',
  forbiddenConsole: 'pending finding: the 403 page logs [NUXT_E1005] on load (admin middleware aborts during SSR)',
  settingsFocus: 'pending finding: closing the call settings dialog (opened from the More menu) leaves focus on <body>',
  dashboardOverflow:
    'pending finding: a long room name overflows the dashboard on phones (RoomListItem title is w-fit, no truncation)',
  touchTargets:
    'pending finding: touch targets under 44 px on phones (shadcn buttons, inputs, selects, switches 18-40 px; logo, text links, Show password 24 px)',
  callTopTargets:
    'pending finding: the E2EE badge (32 px) and the tile options button (28 px) are under 44 px on phones',
} as const

// ---- Themes -------------------------------------------------------------------------------------------------------

export type Theme = 'light' | 'dark'
export const THEMES: readonly Theme[] = ['light', 'dark']
/** @nuxtjs/color-mode storage key (nuxt.config.ts `colorMode.storageKey`); the theme menu writes it. */
const COLOR_MODE_KEY = 'blinq-color-mode'

/**
 * Stores `theme` as the chosen theme before every page script, like the theme menu does. The color-mode head script
 * reads it before the first paint, so this works in every engine (an emulated `prefers-color-scheme` is dropped by
 * Firefox when COOP moves the first navigation into a new browsing context group).
 */
export async function useTheme(context: BrowserContext, theme: Theme): Promise<void> {
  await context.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        // about:blank and other opaque origins have no storage.
      }
    },
    { key: COLOR_MODE_KEY, value: theme },
  )
}

export async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
}

// ---- axe ----------------------------------------------------------------------------------------------------------

/** WCAG 2.0, 2.1 and 2.2 level A and AA rules. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>
type AxeViolation = AxeResults['violations'][number]

export interface ScanOptions {
  /** Limits the scan to these selectors (an open dialog or panel); default the whole document. */
  include?: string[]
  exclude?: string[]
  /**
   * Rules switched off for this one scan, each with the pending finding that explains why
   * (`{ 'color-contrast': 'pending finding: muted text on the card is 3.9:1' }`). The fix agent removes the entry.
   */
  pending?: Record<string, string>
}

/** Waits until finite CSS animations and transitions have finished (contrast is measured on the final frame). */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end)
    })
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  })
}

function describeViolation(violation: AxeViolation): string {
  const nodes = violation.nodes.slice(0, 6).map((node) => {
    const target = node.target.map(String).join(' >> ')
    const data = node.any[0]?.data as { contrastRatio?: number; fgColor?: string; bgColor?: string } | undefined
    const contrast = data?.contrastRatio ? ` (${data.contrastRatio}:1, ${data.fgColor} on ${data.bgColor})` : ''
    return `${target}${contrast}`
  })
  const more = violation.nodes.length > nodes.length ? ` (+${violation.nodes.length - nodes.length} more)` : ''
  return `[${violation.impact}] ${violation.id}: ${violation.help} -> ${nodes.join(' | ')}${more}`
}

/**
 * Runs axe on the current page state and records (soft) every serious or critical WCAG A/AA violation, so one test
 * can scan several states and report all of them. Minor and moderate results become annotations.
 */
export async function expectAccessible(page: Page, label: string, options: ScanOptions = {}): Promise<void> {
  await settleAnimations(page)
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS)
  for (const selector of options.include ?? []) builder = builder.include(selector)
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector)
  const pending = Object.keys(options.pending ?? {})
  if (pending.length > 0) builder = builder.disableRules(pending)
  const results = await builder.analyze()

  const info = test.info()
  await info.attach(`axe ${label}.json`, {
    body: JSON.stringify({ url: results.url, pending: options.pending ?? {}, violations: results.violations }, null, 2),
    contentType: 'application/json',
  })
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const other = results.violations.filter((v) => !blocking.includes(v))
  if (other.length > 0) {
    info.annotations.push({
      type: 'axe (minor/moderate)',
      description: `${label}: ${other.map(describeViolation).join('; ')}`,
    })
  }
  expect.soft(blocking.map(describeViolation), `serious or critical WCAG A/AA violations on ${label}`).toEqual([])
}

// ---- Keyboard -----------------------------------------------------------------------------------------------------

/** Presses `key` until `target` (or something inside it) has focus. */
/**
 * The key that moves focus to the next element, links and buttons included. WebKit on macOS follows Safari's default
 * ("Press Tab to highlight each item" off): Tab skips links and buttons there and Option+Tab reaches everything,
 * which is what a Safari keyboard user presses. Other engines (and WebKit on Linux) treat Alt+Tab like Tab.
 */
export function tabKey(page: Page): string {
  return page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab'
}

/** The key that moves focus to the previous element (see `tabKey`). */
export function shiftTabKey(page: Page): string {
  return tabKey(page).replace('Tab', 'Shift+Tab')
}

/** The opposite direction of a focus-moving key (Tab and Shift+Tab, ArrowDown and ArrowUp). */
function reverseKey(key: string): string {
  if (key.includes('Shift+')) return key.replace('Shift+', '')
  if (key.includes('Tab')) return key.replace('Tab', 'Shift+Tab')
  return key === 'ArrowDown' ? 'ArrowUp' : key === 'ArrowUp' ? 'ArrowDown' : key
}

/**
 * Presses `key` (default: next element) until `target` (or something inside it) has focus. When focus stops moving
 * (Firefox leaves the page for the browser UI after the last element instead of wrapping to the top), it turns
 * around and continues with the opposite key, as a keyboard user would.
 */
export async function tabTo(page: Page, target: Locator, options: { max?: number; key?: string } = {}): Promise<void> {
  const { max = 40, key = tabKey(page) } = options
  await expect(target).toBeVisible()
  const visited: string[] = []
  let direction = key
  let previous: string | undefined
  for (let i = 0; i <= max; i++) {
    const focused = await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
    if (focused) return
    const current = await activeElement(page)
    if (current === previous && direction === key) direction = reverseKey(key)
    previous = current
    if (visited.at(-1) !== current) visited.push(current)
    await page.keyboard.press(direction)
  }
  throw new Error(
    `${String(target)} did not receive focus after ${max} presses of ${key}; focus went through: ${[...new Set(visited)].slice(0, 40).join(', ')}`,
  )
}

/** Short description of the focused element (for messages). */
export async function activeElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return 'body'
    const name = el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 40)
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${name ?? ''}"`
  })
}

export interface FocusStop {
  element: string
  /** The element or one of its two ancestors looks different from its unfocused state (outline, ring, colors). */
  indicator: boolean
  /** Some part of the element is inside the viewport (not hidden behind the edge). */
  inViewport: boolean
}

/** Records the unfocused look of every focusable element and its two ancestors (the baseline of `walkFocus`). */
async function recordFocusBaseline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const look = (el: Element | null) => {
      if (!el) return ''
      const s = getComputedStyle(el)
      return [
        s.outlineStyle,
        s.outlineWidth,
        s.outlineColor,
        s.outlineOffset,
        s.boxShadow,
        s.borderTopColor,
        s.borderBottomColor,
        s.backgroundColor,
        s.color,
        s.textDecorationLine,
      ].join('|')
    }
    const chain = (el: Element) => [look(el), look(el.parentElement), look(el.parentElement?.parentElement ?? null)]
    const baseline = new WeakMap<Element, string[]>()
    const selector =
      'a[href], button, input, select, textarea, summary, [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="combobox"], [tabindex]'
    for (const el of document.querySelectorAll(selector)) baseline.set(el, chain(el))
    Object.assign(window, { __a11yFocus: { baseline, chain } })
  })
}

async function currentFocusStop(page: Page): Promise<(FocusStop & { key: string }) | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body || el === document.documentElement) return null
    const state = (
      window as unknown as { __a11yFocus: { baseline: WeakMap<Element, string[]>; chain: (el: Element) => string[] } }
    ).__a11yFocus
    const before = state.baseline.get(el)
    const now = state.chain(el)
    const box = el.getBoundingClientRect()
    const name = (el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent ?? '')
      .trim()
      .slice(0, 40)
    const element = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${name}"`
    return {
      key: `${element}@${Math.round(box.left)},${Math.round(box.top)}`,
      element,
      // No baseline: the element appeared after the walk started; nothing to compare with, so it is not judged.
      indicator: before ? now.some((value, i) => value !== before[i]) : true,
      inViewport: box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
    }
  })
}

/**
 * Tabs through the page from the top (at most `max` stops, until focus wraps) and reports every stop: whether focus
 * is visible on it and inside the viewport. Mouse-free and side-effect-free (no element is blurred or clicked).
 */
export async function walkFocus(page: Page, max = 30): Promise<FocusStop[]> {
  await page.mouse.move(0, 0)
  await recordFocusBaseline(page)
  const stops: FocusStop[] = []
  const seen = new Set<string>()
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(tabKey(page))
    // Give transitions (shadcn `transition-all`, 150 ms) time to move away from the unfocused look.
    await page.waitForTimeout(120)
    const stop = await currentFocusStop(page)
    if (!stop) continue
    if (seen.has(stop.key)) break
    seen.add(stop.key)
    stops.push({ element: stop.element, indicator: stop.indicator, inViewport: stop.inViewport })
  }
  return stops
}

/**
 * Checks that focus never reaches the page behind `container` during `presses` presses of Tab and of Shift+Tab.
 * Focus may visit the browser's own UI (`document.activeElement` is <body> then): reka-ui wraps plain Tab at the
 * edges, but WebKit's Option+Tab (`tabKey`) passes through the toolbar before it comes back into the dialog.
 */
export async function expectFocusTrapped(page: Page, container: Locator, presses = 12): Promise<void> {
  for (const key of [tabKey(page), shiftTabKey(page)]) {
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key)
      const inside = await container.evaluate(
        (el) => el.contains(document.activeElement) || document.activeElement === document.body,
      )
      expect(inside, `focus after ${i + 1}x ${key} is ${await activeElement(page)}, outside the dialog`).toBe(true)
    }
  }
}

// ---- Motion -------------------------------------------------------------------------------------------------------

export interface MotionAnimation {
  name: string
  target: string
  duration: number
  iterations: number
  properties: string[]
}

/**
 * Running animations and transitions that move something (anything but opacity and colors) for longer than
 * `minMs` or forever. Under `prefers-reduced-motion: reduce` the app must have none.
 */
export async function longMotion(page: Page, minMs = 500): Promise<MotionAnimation[]> {
  return page.evaluate((min) => {
    const still = new Set([
      'opacity',
      'color',
      'background-color',
      'backgroundColor',
      'visibility',
      'offset',
      'composite',
      'easing',
      'computedOffset',
      'fill-opacity',
    ])
    const out: MotionAnimation[] = []
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'running') continue
      const effect = animation.effect as KeyframeEffect | null
      if (!effect) continue
      const timing = effect.getComputedTiming()
      const duration = Number(timing.duration) || 0
      const iterations = Number(timing.iterations)
      const total = Number.isFinite(iterations) ? duration * iterations : Number.POSITIVE_INFINITY
      if (total < min) continue
      const properties = [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter(
        (property) => !still.has(property),
      )
      if (properties.length === 0) continue
      const target = effect.target as HTMLElement | null
      const name =
        'animationName' in animation
          ? String((animation as CSSAnimation).animationName)
          : 'transitionProperty' in animation
            ? `transition ${String((animation as CSSTransition).transitionProperty)}`
            : 'script animation'
      out.push({
        name,
        target: target
          ? `${target.tagName.toLowerCase()}.${String(target.className).split(' ').slice(0, 3).join('.')}`
          : '?',
        duration,
        iterations,
        properties,
      })
    }
    return out
  }, minMs)
}

// ---- Layout -------------------------------------------------------------------------------------------------------

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

export interface TargetBox {
  element: string
  /** shadcn-vue component of the element (`data-slot`: button, input, switch, ...), if any. */
  slot: string | null
  width: number
  height: number
  left: number
  right: number
}

/**
 * Visible interactive elements (links, buttons, inputs, ARIA widgets), with their boxes. Skips inline text links
 * (WCAG exempts them), screen-reader-only and decorative elements, and native inputs that ARIA widgets hide.
 */
export async function interactiveTargets(page: Page, root?: string): Promise<TargetBox[]> {
  return page.evaluate((rootSelector) => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="combobox"], [role="slider"], [tabindex]:not([tabindex^="-"])'
    const scope = rootSelector ? document.querySelector(rootSelector) : document
    if (!scope) throw new Error(`no element matches ${rootSelector}`)
    const out: TargetBox[] = []
    for (const el of scope.querySelectorAll<HTMLElement>(selector)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue
      // Composite widgets (toggle groups, toolbars) hand focus to their items: the items are the targets.
      if (el.querySelector(selector)) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.pointerEvents === 'none' || Number(style.opacity) === 0) continue
      const box = el.getBoundingClientRect()
      // sr-only elements (skip link before focus) are 1x1 and clipped.
      if (box.width <= 1 || box.height <= 1) continue
      if (el.tagName === 'A' && style.display === 'inline') continue
      const name = (el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40)
      const slot = el.getAttribute('data-slot')
      out.push({
        element: `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${el.id ? `#${el.id}` : ''} "${name}"`,
        slot,
        width: Math.round(box.width),
        height: Math.round(box.height),
        left: Math.round(box.left),
        right: Math.round(box.right),
      })
    }
    return out
  }, root)
}

/** Interactive elements that stick out of the viewport sideways (unless a horizontal scroller clips them). */
export async function controlsOutsideViewport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="checkbox"], [role="combobox"], [role="tab"]'
    const outside: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const box = el.getBoundingClientRect()
      if (box.width <= 1 || box.height <= 1) continue
      let clipped = false
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') {
          if (parent !== document.documentElement && parent !== document.body) clipped = true
          break
        }
      }
      if (clipped) continue
      if (box.left < -1 || box.right > document.documentElement.clientWidth + 1) {
        const name = (el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent ?? '')
          .trim()
          .slice(0, 40)
        outside.push(`${el.tagName.toLowerCase()} "${name}" (${Math.round(box.left)}..${Math.round(box.right)})`)
      }
    }
    return outside
  })
}

/** Interactive elements (inside `root`, default the page) smaller than `min` CSS pixels in either direction. */
export async function smallTargets(page: Page, min: number, root?: string): Promise<string[]> {
  return (await interactiveTargets(page, root))
    .filter((target) => target.width < min || target.height < min)
    .map((target) => `${target.element} ${target.width}x${target.height}`)
}

/** The innermost elements that reach past the right edge of the viewport (what makes a page overflow). */
export async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1
    const beyond = [...document.body.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.right > limit
    })
    return beyond
      .filter((el) => !beyond.some((other) => other !== el && el.contains(other)))
      .slice(0, 6)
      .map((el) => {
        const testid = el.closest('[data-testid]')?.getAttribute('data-testid')
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
        return `${el.tagName.toLowerCase()}${testid ? ` in [data-testid=${testid}]` : ''} "${text}" right=${Math.round(el.getBoundingClientRect().right)}`
      })
  })
}

/** Checks the page fits `width`: no horizontal overflow and no control outside the viewport. */
export async function expectFits(page: Page, label: string): Promise<void> {
  await settleAnimations(page)
  const overflow = await horizontalOverflow(page)
  const culprits = overflow > 0 ? ` (${(await overflowingElements(page)).join('; ')})` : ''
  expect.soft(overflow, `${label}: horizontal overflow (px)${culprits}`).toBeLessThanOrEqual(0)
  expect.soft(await controlsOutsideViewport(page), `${label}: controls outside the viewport`).toEqual([])
}

/**
 * Records a check that currently fails because of a product defect, without failing the test: the observed value
 * becomes a `pending finding` annotation. The fix agent replaces the call with the real assertion.
 */
export function notePending(finding: string, observed: unknown): void {
  test
    .info()
    .annotations.push({ type: 'pending finding', description: `${finding} (observed: ${JSON.stringify(observed)})` })
}

/** Waits until the local camera and microphone are published (toggling earlier races the SDK's first publish). */
export async function waitForLocalTracks(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hooks = (
            window as unknown as {
              __blinqTest?: { state: { media?: { micTrackSid?: string | null; cameraTrackSid?: string | null } } }
            }
          ).__blinqTest
          return Boolean(hooks?.state.media?.micTrackSid && hooks.state.media.cameraTrackSid)
        }),
      { timeout: 20_000, message: 'local camera and microphone published' },
    )
    .toBe(true)
}

// ---- Data ---------------------------------------------------------------------------------------------------------

/**
 * Waits until `count` more unauthenticated auth requests (invite preview, email confirmation, password reset) fit into
 * the `auth-ip` budget (10 per minute; every browser request comes from the e2e Caddy, docs/TESTING.md §6.1), then
 * books them. Bookings live next to the E2E logs, so they outlive a worker and are shared by the a11y specs.
 */
export async function spendAuthBudget(count: number): Promise<void> {
  const file = join(process.env.E2E_LOG_DIR ?? join(process.cwd(), 'logs', 'e2e'), 'auth-ip-budget.json')
  const allowed = 10 - 3 // headroom for auth specs that do not book
  const windowMs = 61_500
  for (;;) {
    let bookings: number[] = []
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(value)) bookings = value.filter((item): item is number => typeof item === 'number')
    } catch {
      bookings = []
    }
    const now = Date.now()
    const live = bookings.filter((at) => at > now - windowMs && at <= now).sort((a, b) => a - b)
    if (live.length + count <= allowed) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify([...live, ...Array.from({ length: count }, () => now)]))
      return
    }
    const wait = live[live.length + count - allowed - 1]! + windowMs - now
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, wait)))
  }
}

/** A token in the fragment token format that matches nothing on the server. */
export function unknownToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Puts `user` into the "must change password" state (admin-created or admin-reset accounts). */
export async function requirePasswordChange(db: E2eDb, user: E2eUser): Promise<void> {
  await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id))
}

/** An email confirmation token for `user` (what the verification email links to). Books the page's request. */
export async function emailVerificationToken(db: E2eDb, user: E2eUser, secrets: Secrets): Promise<string> {
  await spendAuthBudget(1)
  await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, user.id))
  const token = randomToken()
  secrets.track(token, 'email verification token')
  await db.insert(emailTokens).values({
    userId: user.id,
    purpose: 'verify_email',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  return token
}

/** An account invite token (what `/invite#<token>` carries). Books the page's preview request. */
export async function accountInviteToken(db: E2eDb, secrets: Secrets): Promise<string> {
  await spendAuthBudget(1)
  const token = randomToken()
  secrets.track(token, 'account invite token')
  await db.insert(userInvites).values({
    tokenHash: hashToken(token),
    email: null,
    role: 'user',
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  return token
}

/** Recording rows in every list state (no files: nothing is played or downloaded). Returns the processing one. */
export async function seedRecordings(db: E2eDb, owner: E2eUser, room: E2eRoom): Promise<{ processingId: string }> {
  const now = Date.now()
  const rows = await db
    .insert(recordings)
    .values([
      {
        roomId: room.id,
        createdBy: owner.id,
        status: 'ready',
        title: 'Quarterly planning',
        sizeBytes: 48_000_000,
        durationMs: 1_800_000,
        width: 1280,
        height: 720,
        startedAt: new Date(now - 7_200_000),
        endedAt: new Date(now - 5_400_000),
        expiresAt: new Date(now + 30 * 86_400_000),
      },
      {
        roomId: room.id,
        createdBy: owner.id,
        status: 'processing',
        title: 'Design review',
        startedAt: new Date(now - 600_000),
        endedAt: new Date(now - 60_000),
      },
      {
        roomId: room.id,
        createdBy: owner.id,
        status: 'failed',
        title: 'Retro',
        error: 'e2e: processing failed',
        startedAt: new Date(now - 86_400_000),
        endedAt: new Date(now - 86_000_000),
      },
    ])
    .returning({ id: recordings.id, status: recordings.status })
  return { processingId: rows.find((row) => row.status === 'processing')!.id }
}

// ---- Calls --------------------------------------------------------------------------------------------------------

export interface Peer {
  page: Page
  context: BrowserContext
  identity: string
}

/**
 * A signed-in participant in its own browser context through the call harness (admitted by `host` when the room has
 * a waiting room). The page under test stays on the real `/m/<slug>` flow; this peer only adds a remote tile.
 */
export async function addPeer(
  rooms: RoomsFixture,
  guards: Guards,
  browser: Browser,
  room: E2eRoom,
  host: E2eUser,
  name: string,
): Promise<Peer> {
  const user = await rooms.createUser({ displayName: name })
  const inviteToken = await rooms.createInvite(room, host)
  const join: JoinResult = await rooms.join(room, user, { inviteToken })
  if (join.status === 'waiting') {
    await rooms.admit(room, host, join.requestId!)
    await rooms.waitForAdmission(join)
  }
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } })
  await guards.watch(context)
  await rooms.useIdentity(context, join)
  const page = await context.newPage()
  await page.goto(rooms.harnessPath(room, join.grant!, name) + '&mic=0')
  await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('join-button').click()
  await waitForPhase(page, 'inCall')
  return { page, context, identity: join.grant!.identity }
}

/** Leaves a harness peer gracefully (a torn-down connection makes the SDK log errors) and closes its context. */
export async function removePeer(peer: Peer | undefined): Promise<void> {
  if (!peer) return
  await peer.page
    .evaluate(async () => {
      const hooks = (window as unknown as { __blinqTest?: { state: { harness?: { leave?: () => Promise<void> } } } })
        .__blinqTest
      await hooks?.state.harness?.leave?.()
    })
    .catch(() => undefined)
  await peer.context.close().catch(() => undefined)
}
