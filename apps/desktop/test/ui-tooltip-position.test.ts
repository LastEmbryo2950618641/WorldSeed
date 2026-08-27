import { describe, expect, it } from "vitest"

import { computeUiTooltipPosition } from "../src/renderer/src/components/ui-tooltip-position.js"

describe("computeUiTooltipPosition", () => {
  it("prefers top placement when there is room above", () => {
    const position = computeUiTooltipPosition({
      anchorRect: { left: 100, top: 120, right: 130, bottom: 150, width: 30, height: 30 },
      tooltipWidth: 80,
      tooltipHeight: 28,
      viewportWidth: 400,
      viewportHeight: 300,
    })
    expect(position.placement).toBe("top")
    expect(position.top).toBeLessThan(120)
  })

  it("flips to bottom when there is not enough room above", () => {
    const position = computeUiTooltipPosition({
      anchorRect: { left: 100, top: 8, right: 130, bottom: 38, width: 30, height: 30 },
      tooltipWidth: 80,
      tooltipHeight: 28,
      viewportWidth: 400,
      viewportHeight: 300,
    })
    expect(position.placement).toBe("bottom")
    expect(position.top).toBeGreaterThanOrEqual(38)
  })

  it("clamps horizontal position inside the viewport", () => {
    const position = computeUiTooltipPosition({
      anchorRect: { left: 4, top: 120, right: 24, bottom: 150, width: 20, height: 30 },
      tooltipWidth: 120,
      tooltipHeight: 28,
      viewportWidth: 200,
      viewportHeight: 300,
    })
    expect(position.left).toBeGreaterThanOrEqual(8)
    expect(position.left + 120).toBeLessThanOrEqual(192)
  })
})
