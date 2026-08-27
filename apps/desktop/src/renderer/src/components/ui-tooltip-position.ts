export type TooltipPlacement = "top" | "bottom"

export type TooltipPosition = Readonly<{
  left: number
  top: number
  arrowX: number
  placement: TooltipPlacement
}>

type RectLike = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}>

export function computeUiTooltipPosition(input: Readonly<{
  anchorRect: RectLike
  tooltipWidth: number
  tooltipHeight: number
  viewportWidth: number
  viewportHeight: number
  gap?: number
  margin?: number
}>): TooltipPosition {
  const gap = input.gap ?? 7
  const margin = input.margin ?? 8
  const anchorCenterX = input.anchorRect.left + input.anchorRect.width / 2

  const fitsTop = input.anchorRect.top - gap - input.tooltipHeight >= margin
  const fitsBottom = input.anchorRect.bottom + gap + input.tooltipHeight <= input.viewportHeight - margin
  let placement: TooltipPlacement = "top"
  if (fitsTop || !fitsBottom) {
    placement = "top"
  } else {
    placement = "bottom"
  }

  let top = placement === "top"
    ? input.anchorRect.top - gap - input.tooltipHeight
    : input.anchorRect.bottom + gap
  if (top < margin) top = margin
  if (top + input.tooltipHeight > input.viewportHeight - margin) {
    top = Math.max(margin, input.viewportHeight - margin - input.tooltipHeight)
  }

  let left = anchorCenterX - input.tooltipWidth / 2
  left = Math.max(margin, Math.min(left, input.viewportWidth - input.tooltipWidth - margin))

  const arrowX = Math.max(10, Math.min(anchorCenterX - left, input.tooltipWidth - 10))

  return { left, top, arrowX, placement }
}
