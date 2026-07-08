import Svg, { Path } from 'react-native-svg'
import { colors } from '../theme/mobile-theme'

type Props = {
  size?: number
  color?: string
}

export function PebbleLogo({ size = 24, color = colors.textPrimary }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256">
      <Path
        fill={color}
        d="M101 50h54c18 0 32 12 32 28s-14 28-32 28h-54c-18 0-32-12-32-28s14-28 32-28Z"
      />
      <Path
        fill={color}
        d="M72 107h112c21 0 38 14 38 33s-17 33-38 33H72c-21 0-38-14-38-33s17-33 38-33Z"
      />
      <Path
        fill={color}
        d="M55 173h146c24 0 43 15 43 34s-19 34-43 34H55c-24 0-43-15-43-34s19-34 43-34Z"
      />
    </Svg>
  )
}
