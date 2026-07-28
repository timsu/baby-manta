// Dog-mode replacement for the 2D <Board>. Receives Shell's own callbacks so
// every interaction routes through the exact code paths the 2D UI uses.
// Default export so Shell can React.lazy() it and keep three.js out of the
// main bundle.

import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import { GameCanvas } from "./GameCanvas.tsx";
import type { GameHandlers } from "./gameActions.ts";

export interface GameBoardProps {
  /** False while a modal is open — freezes dog input so typing doesn't move it. */
  active: boolean;
  handlers: GameHandlers;
}

export default function GameBoard({ active, handlers }: GameBoardProps) {
  return <GameCanvas active={active} handlers={handlers} />;
}
