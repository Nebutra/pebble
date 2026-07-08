import { ColorSchemeName } from 'react-native'

export type PebbleThemeMode = 'light' | 'dark'

export interface PebbleTheme {
  mode: PebbleThemeMode
  colors: PebbleThemeColors
  radii: PebbleRadii
  spacing: PebbleSpacing
  typography: PebbleTypography
}

export interface PebbleThemeColors {
  background: string
  foreground: string
  card: string
  cardForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  primary: string
  primaryForeground: string
  border: string
  input: string
  ring: string
  destructive: string
  success: string
  gitAdded: string
  gitModified: string
  gitDeleted: string
  gitRenamed: string
  gitIgnored: string
}

export interface PebbleRadii {
  sm: number
  md: number
  lg: number
  pill: number
}

export interface PebbleSpacing {
  xs: number
  sm: number
  md: number
  lg: number
  xl: number
  xxl: number
}

export interface PebbleTypography {
  fontFamily: string
  monoFamily: string
  captionSize: number
  bodySize: number
  titleSize: number
}

const radii: PebbleRadii = {
  sm: 6,
  md: 8,
  lg: 10,
  pill: 999,
}

const spacing: PebbleSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

const typography: PebbleTypography = {
  fontFamily: 'Geist',
  monoFamily: 'SF Mono',
  captionSize: 12,
  bodySize: 14,
  titleSize: 18,
}

// Why: React Native cannot consume the desktop CSS variables directly, so these
// values mirror the canonical tokens from src/renderer/src/assets/main.css.
const lightColors: PebbleThemeColors = {
  background: '#fff',
  foreground: '#0a0a0a',
  card: '#fff',
  cardForeground: '#0a0a0a',
  muted: '#f5f5f5',
  mutedForeground: '#737373',
  accent: '#f5f5f5',
  accentForeground: '#171717',
  primary: '#171717',
  primaryForeground: '#fafafa',
  border: '#e5e5e5',
  input: '#e5e5e5',
  ring: '#a1a1a1',
  destructive: '#e40014',
  success: '#15803d',
  gitAdded: '#587c0c',
  gitModified: '#895503',
  gitDeleted: '#ad0707',
  gitRenamed: '#007acc',
  gitIgnored: '#8c8c8c',
}

const darkColors: PebbleThemeColors = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  card: '#171717',
  cardForeground: '#fafafa',
  muted: '#262626',
  mutedForeground: '#a1a1a1',
  accent: '#404040',
  accentForeground: '#fafafa',
  primary: '#e5e5e5',
  primaryForeground: '#171717',
  border: 'rgba(255, 255, 255, 0.07)',
  input: 'rgba(255, 255, 255, 0.15)',
  ring: '#737373',
  destructive: '#ff6568',
  success: '#86efac',
  gitAdded: '#81b88b',
  gitModified: '#e2c08d',
  gitDeleted: '#c74e39',
  gitRenamed: '#73c991',
  gitIgnored: '#6e6e6e',
}

export function getPebbleTheme(colorScheme: ColorSchemeName): PebbleTheme {
  const mode: PebbleThemeMode = colorScheme === 'dark' ? 'dark' : 'light'

  return {
    mode,
    colors: mode === 'dark' ? darkColors : lightColors,
    radii,
    spacing,
    typography,
  }
}
