# UI & Design System 🎨

## Aesthetics & Theme
- Sleek modern dark mode (e.g. HSL tailored color palette).
- Smooth glassmorphism, dynamic gradients, micro-animations.

## Color Palette (CSS Variables)
```css
:root {
  --background: 240 10% 3.9%;
  --foreground: 0 0% 98%;
  --primary: 263.4 90% 50.4%; /* Neon Violet */
  --accent: 180 100% 50%;     /* Neon Cyan */
  --card: 240 10% 10%;
  --border: 240 5.9% 15%;
}
```

## Typography
- Main Font: `Inter` or `Outfit` via Google Fonts.
- Browser default sans-serif as fallback.

## Key UI Components
- **Navbar**: Floating with blur filter (`backdrop-filter: blur(12px)`).
- **Cards**: Glassmorphic borders with linear gradient.
- **Buttons**: Hover glow and micro-zoom effects.
