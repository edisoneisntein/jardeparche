import { lazy, Suspense, type ReactNode } from "react";

const ThreeArcScene = lazy(() => import("./ThreeArcScene"));

export function ArcReactorContainer({
  state,
  reducedMotion,
  micLevel,
  ttsSpeaking,
  color,
  particleColor,
  children,
}: {
  state: string | null;
  reducedMotion: boolean;
  micLevel: number;
  ttsSpeaking: boolean;
  color: string;
  particleColor: string;
  children?: ReactNode;
}) {
  return (
    <Suspense fallback={<div className="reactor-placeholder-glow" aria-hidden="true" />}>
      <ThreeArcScene
        state={state}
        reducedMotion={reducedMotion}
        micLevel={micLevel}
        ttsSpeaking={ttsSpeaking}
        color={color}
        particleColor={particleColor}
      />
    </Suspense>
  );
}

export default ArcReactorContainer;