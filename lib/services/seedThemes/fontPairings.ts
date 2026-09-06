
export const DAISYUI_THEME_NAMES = [
  'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate', 'synthwave', 'retro',
  'cyberpunk', 'valentine', 'halloween', 'garden', 'forest', 'aqua', 'lofi', 'pastel',
  'fantasy', 'wireframe', 'black', 'luxury', 'dracula', 'cmyk', 'autumn', 'business',
  'acid', 'lemonade', 'night', 'coffee', 'winter', 'dim', 'nord', 'sunset',
] as const;

export const BOOTSWATCH_THEME_NAMES = [
  'Brite', 'Cerulean', 'Cosmo', 'Cyborg', 'Darkly', 'Flatly', 'Journal', 'Litera', 'Lumen',
  'Lux', 'Materia', 'Minty', 'Morph', 'Pulse', 'Quartz', 'Sandstone', 'Simplex', 'Sketchy',
  'Slate', 'Solar', 'Spacelab', 'Superhero', 'United', 'Vapor', 'Yeti', 'Zephyr',
] as const;

export interface FontPairing {
  fontHeading: string;
  fontBody: string;
}

const INTER: FontPairing = { fontHeading: "'Inter', sans-serif", fontBody: "'Inter', sans-serif" };
const ROUNDED_PLAYFUL: FontPairing = { fontHeading: "'Baloo 2', sans-serif", fontBody: "'Nunito', sans-serif" };
const ELEGANT_SERIF: FontPairing = { fontHeading: "'Playfair Display', serif", fontBody: "'Lora', serif" };
const NEON_TECH: FontPairing = { fontHeading: "'Orbitron', sans-serif", fontBody: "'Rajdhani', sans-serif" };
const FORMAL_SANS: FontPairing = { fontHeading: "'Source Sans Pro', sans-serif", fontBody: "'Source Sans Pro', sans-serif" };
const EARTHY_SERIF: FontPairing = { fontHeading: "'Merriweather', serif", fontBody: "'Lora', serif" };
const NATURE_SANS: FontPairing = { fontHeading: "'Poppins', sans-serif", fontBody: "'Karla', sans-serif" };
const VINTAGE_MONO: FontPairing = { fontHeading: "'Special Elite', cursive", fontBody: "'Courier New', monospace" };
const LUXURY_SERIF: FontPairing = { fontHeading: "'Cormorant Garamond', serif", fontBody: "'EB Garamond', serif" };
const GOTHIC_SERIF: FontPairing = { fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif" };
const LOUD_DISPLAY: FontPairing = { fontHeading: "'Bungee', cursive", fontBody: "'Share Tech Mono', monospace" };
const EDITORIAL_SERIF: FontPairing = { fontHeading: "'Merriweather', serif", fontBody: "'PT Serif', serif" };
const MATERIAL_SANS: FontPairing = { fontHeading: "'Roboto', sans-serif", fontBody: "'Roboto', sans-serif" };
const CLEAN_LATO: FontPairing = { fontHeading: "'Lato', sans-serif", fontBody: "'Lato', sans-serif" };
const HAND_DRAWN: FontPairing = { fontHeading: "'Neucha', cursive", fontBody: "'Architects Daughter', cursive" };
const BOLD_DARK: FontPairing = { fontHeading: "'Oswald', sans-serif", fontBody: "'Roboto', sans-serif" };
const BRANDED_UBUNTU: FontPairing = { fontHeading: "'Ubuntu', sans-serif", fontBody: "'Ubuntu', sans-serif" };

const FONT_PAIRINGS: Record<string, FontPairing> = {
  // DaisyUI (32)
  light: INTER,
  dark: INTER,
  cupcake: ROUNDED_PLAYFUL,
  bumblebee: ROUNDED_PLAYFUL,
  emerald: NATURE_SANS,
  corporate: FORMAL_SANS,
  synthwave: NEON_TECH,
  retro: VINTAGE_MONO,
  cyberpunk: { fontHeading: "'Rajdhani', sans-serif", fontBody: "'Share Tech Mono', monospace" },
  valentine: ELEGANT_SERIF,
  halloween: { fontHeading: "'Creepster', cursive", fontBody: "'Special Elite', cursive" },
  garden: { fontHeading: "'Quicksand', sans-serif", fontBody: "'Karla', sans-serif" },
  forest: EARTHY_SERIF,
  aqua: NATURE_SANS,
  lofi: INTER,
  pastel: ROUNDED_PLAYFUL,
  fantasy: { fontHeading: "'Cinzel Decorative', serif", fontBody: "'EB Garamond', serif" },
  wireframe: { fontHeading: "'Courier New', monospace", fontBody: "'Courier New', monospace" },
  black: INTER,
  luxury: LUXURY_SERIF,
  dracula: GOTHIC_SERIF,
  cmyk: { fontHeading: "'Bebas Neue', sans-serif", fontBody: "'Roboto Condensed', sans-serif" },
  autumn: EARTHY_SERIF,
  business: FORMAL_SANS,
  acid: LOUD_DISPLAY,
  lemonade: ROUNDED_PLAYFUL,
  night: NEON_TECH,
  coffee: EARTHY_SERIF,
  winter: INTER,
  dim: INTER,
  nord: NATURE_SANS,
  sunset: ROUNDED_PLAYFUL,
  // Bootswatch (26)
  Brite: NATURE_SANS,
  Cerulean: FORMAL_SANS,
  Cosmo: FORMAL_SANS,
  Cyborg: { fontHeading: "'Rajdhani', sans-serif", fontBody: "'Share Tech Mono', monospace" },
  Darkly: INTER,
  Flatly: CLEAN_LATO,
  Journal: EDITORIAL_SERIF,
  Litera: EDITORIAL_SERIF,
  Lumen: FORMAL_SANS,
  Lux: { fontHeading: "'Playfair Display', serif", fontBody: "'Lato', sans-serif" },
  Materia: MATERIAL_SANS,
  Minty: NATURE_SANS,
  Morph: NATURE_SANS,
  Pulse: NATURE_SANS,
  Quartz: NATURE_SANS,
  Sandstone: CLEAN_LATO,
  Simplex: FORMAL_SANS,
  Sketchy: HAND_DRAWN,
  Slate: FORMAL_SANS,
  Solar: EDITORIAL_SERIF,
  Spacelab: MATERIAL_SANS,
  Superhero: BOLD_DARK,
  United: BRANDED_UBUNTU,
  Vapor: NEON_TECH,
  Yeti: FORMAL_SANS,
  Zephyr: NATURE_SANS,
};

export function getFontPairing(themeName: string): FontPairing {
  const pairing = FONT_PAIRINGS[themeName];
  if (!pairing) {
    throw new Error(`No font pairing defined for theme "${themeName}" — add one to FONT_PAIRINGS in lib/services/seedThemes/fontPairings.ts.`);
  }
  return pairing;
}
