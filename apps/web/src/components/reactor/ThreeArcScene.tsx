import { Anillo1 } from "./Anillo1";
import { Anillo2 } from "./Anillo2";
import { Anillo3 } from "./Anillo3";
import { Anillo4 } from "./Anillo4";
import { NucleoParticulas } from "./NucleoParticulas";
import { NucleoDescarga } from "./NucleoDescarga";
import { ReticleLayer } from "../fx/HoloDeck";
import { VoiceVisualizer } from "../voice/VoiceVisualizer";
import { VoiceEqualizer } from "../voice/VoiceEqualizer";

interface ThreeArcSceneProps {
  state: string | null;
  reducedMotion: boolean;
  micLevel: number;
  ttsSpeaking: boolean;
  color: string;
  particleColor: string;
}

export function ThreeArcScene({
  state,
  reducedMotion,
  micLevel,
  ttsSpeaking,
  color,
  particleColor,
}: ThreeArcSceneProps) {
  return (
    <div className="reactor-stack">
      <div className="nucleo-bloque">
        <Anillo2 state={state} reducedMotion={reducedMotion} />
        <Anillo3 state={state} reducedMotion={reducedMotion} micLevel={micLevel} />
        <Anillo4 state={state} reducedMotion={reducedMotion} color={particleColor} />
      </div>
      <NucleoParticulas
        state={state}
        color={particleColor}
        micLevel={micLevel}
        voz={ttsSpeaking}
        reducedMotion={reducedMotion}
      />
      <NucleoDescarga state={state} reducedMotion={reducedMotion} />
      <Anillo1 state={state} reducedMotion={reducedMotion} />
      <ReticleLayer state={state} reducedMotion={reducedMotion} />
      <VoiceVisualizer
        active={micLevel > 0.01}
        speaking={ttsSpeaking}
        state={state}
        color={color}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}

export default ThreeArcScene;