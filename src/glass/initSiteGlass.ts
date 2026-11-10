import {
  GlassContainer,
  GlassView,
  applyExpoGlassContainerToElement,
  applyExpoGlassToElement,
  injectExpoGlassSVGFilters,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  mountSiteWideExpoGlass,
} from 'expo-glass-effect';
import {
  APPLE_SPRINGS,
  animateCardsWaveCascade,
  animateDynamicIslandToast,
  animateHeroEntrance,
  closeAppleModal,
  computeSpringSamples,
  mountAppleMotionSystem,
  openAppleModal,
  pulseElementPop,
  syncAllSegmentedControls,
  triggerAppleJelly,
} from '../motion/appleMotionEngine';

declare global {
  interface Window {
    ExpoGlassEffect?: {
      GlassView: typeof GlassView;
      GlassContainer: typeof GlassContainer;
      isLiquidGlassAvailable: typeof isLiquidGlassAvailable;
      isGlassEffectAPIAvailable: typeof isGlassEffectAPIAvailable;
      applyExpoGlassToElement: typeof applyExpoGlassToElement;
      applyExpoGlassContainerToElement: typeof applyExpoGlassContainerToElement;
      injectExpoGlassSVGFilters: typeof injectExpoGlassSVGFilters;
      mountSiteWideExpoGlass: typeof mountSiteWideExpoGlass;
    };
    AppleMotion?: {
      APPLE_SPRINGS: typeof APPLE_SPRINGS;
      computeSpringSamples: typeof computeSpringSamples;
      syncAllSegmentedControls: typeof syncAllSegmentedControls;
      animateHeroEntrance: typeof animateHeroEntrance;
      animateCardsWaveCascade: typeof animateCardsWaveCascade;
      openAppleModal: typeof openAppleModal;
      closeAppleModal: typeof closeAppleModal;
      animateDynamicIslandToast: typeof animateDynamicIslandToast;
      pulseElementPop: typeof pulseElementPop;
      triggerAppleJelly: typeof triggerAppleJelly;
    };
  }
}

window.ExpoGlassEffect = {
  GlassView,
  GlassContainer,
  isLiquidGlassAvailable,
  isGlassEffectAPIAvailable,
  applyExpoGlassToElement,
  applyExpoGlassContainerToElement,
  injectExpoGlassSVGFilters,
  mountSiteWideExpoGlass,
};

window.AppleMotion = {
  APPLE_SPRINGS,
  computeSpringSamples,
  syncAllSegmentedControls,
  animateHeroEntrance,
  animateCardsWaveCascade,
  openAppleModal,
  closeAppleModal,
  animateDynamicIslandToast,
  pulseElementPop,
  triggerAppleJelly,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    mountSiteWideExpoGlass();
    mountAppleMotionSystem();
  });
} else {
  mountSiteWideExpoGlass();
  mountAppleMotionSystem();
}
