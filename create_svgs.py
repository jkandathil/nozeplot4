import os

svg_dir = "/Users/jayanozhikandathil/Documents/cursor_projects/data_analysis_app/public/gas_icons"
os.makedirs(svg_dir, exist_ok=True)

svgs = {
    "cylinder.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#3b82f6" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M30 35 L30 90 A 10 10 0 0 0 40 100 L60 100 A 10 10 0 0 0 70 90 L70 35" />
  <path d="M30 35 Q 30 15 40 15 L60 15 Q 70 15 70 35" />
  <rect x="42" y="5" width="16" height="10" />
  <path d="M42 10 L32 10 M32 2 L32 18" />
  <circle cx="50" cy="65" r="12" />
  <path d="M45 65 L55 65" />
</svg>""",
    
    "mfc.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#10b981" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="20" y="25" width="60" height="50" rx="4" />
  <path d="M40 40 L60 60 M40 60 L60 40 Z" fill="#10b981" fill-opacity="0.2" />
  <path d="M5 50 L20 50 M80 50 L95 50" />
  <polygon points="90,45 95,50 90,55" fill="#10b981" />
  <line x1="50" y1="70" x2="50" y2="35" stroke-dasharray="4 4" />
  <polygon points="50,30 45,38 55,38" fill="#10b981" />
</svg>""",
    
    "mixer.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 20 L35 20 M10 50 L35 50 M10 80 L35 80" />
  <rect x="35" y="10" width="30" height="80" rx="4" />
  <path d="M65 50 L95 50" stroke-width="6" />
  <polygon points="90,45 95,50 90,55" fill="#f59e0b" />
</svg>""",
    
    "humidifier.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#0ea5e9" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M25 45 L25 85 A 10 10 0 0 0 35 95 L65 95 A 10 10 0 0 0 75 85 L75 45" />
  <path d="M25 45 Q 25 35 35 35 L40 35 L40 15 L60 15 L60 35 L65 35 Q 75 35 75 45" />
  <path d="M25 60 L75 60" stroke-dasharray="4 4" />
  <path d="M50 5 L50 85" stroke-width="4" />
  <path d="M58 40 L60 40 L60 25 L85 25" />
  <polygon points="80,20 85,25 80,30" fill="#0ea5e9" />
  <circle cx="40" cy="80" r="3" fill="#0ea5e9" />
  <circle cx="60" cy="75" r="4" fill="#0ea5e9" />
  <circle cx="45" cy="65" r="2" fill="#0ea5e9" />
</svg>""",
    
    "y_splitter.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#a855f7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 50 L40 50 L75 20 M40 50 L75 80" />
  <polygon points="70,18 78,17 76,25" fill="#a855f7" />
  <polygon points="70,82 78,83 76,75" fill="#a855f7" />
</svg>""",
    
    "output.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#ec4899" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="10" y="20" width="80" height="60" rx="6" />
  <path d="M20 50 L35 50 L45 30 L55 70 L65 50 L80 50" stroke-width="4" />
  <path d="M10 50 L0 50 M90 50 L100 50 M50 10 L50 0 M50 90 L50 100" stroke-width="2" />
</svg>"""
}

for name, content in svgs.items():
    with open(os.path.join(svg_dir, name), "w") as f:
        f.write(content)

print("SVGs created successfully!")
