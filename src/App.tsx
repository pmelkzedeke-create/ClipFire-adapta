/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

export default function App() {
  const glassReady = isLiquidGlassAvailable();
  return (
    <GlassContainer spacing={20}>
      <GlassView
        glassEffectStyle={{ style: 'regular', animate: true, animationDuration: 0.35 }}
        tintColor="rgba(255, 106, 0, 0.12)"
        isInteractive
        data-liquid-glass-ready={glassReady}
      />
    </GlassContainer>
  );
}
