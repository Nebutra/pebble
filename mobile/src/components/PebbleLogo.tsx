import Svg, { Path } from 'react-native-svg'
import { colors } from '../theme/mobile-theme'

type Props = {
  size?: number
  color?: string
  cutoutColor?: string
}

export function PebbleLogo({
  size = 24,
  color = colors.textPrimary,
  cutoutColor = colors.bgBase
}: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Path
        fill={color}
        d="M504 181c116-3 229 45 297 132 83 108 88 255 17 382-67 121-198 180-355 155-137-22-238-94-279-208-45-126-6-263 102-359 58-51 134-99 218-102z"
      />
      <Path
        fill="none"
        stroke={cutoutColor}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={70}
        d="M395 370 543 518 395 666"
      />
      <Path
        fill="none"
        stroke={cutoutColor}
        strokeLinecap="round"
        strokeWidth={70}
        d="M612 620h131"
      />
    </Svg>
  )
}
