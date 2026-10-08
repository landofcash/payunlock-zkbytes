export interface GaitPose {
  x: number;
  y: number;
  angle: number;
  distance: number;
  running: boolean;
}

export function createLizardGroundedGait(svg: SVGSVGElement): {
  draw(pose: GaitPose, unit: number): unknown;
  reset(): void;
};
