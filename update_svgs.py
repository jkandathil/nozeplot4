import os

svg_dir = "/Users/jayanozhikandathil/Documents/cursor_projects/data_analysis_app/public/gas_icons"

svgs = {
    "cylinder.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M30 35 L30 90 A 10 10 0 0 0 40 100 L60 100 A 10 10 0 0 0 70 90 L70 35" />
  <path d="M30 35 Q 30 15 50 15 Q 70 15 70 35" />
  <rect x="42" y="5" width="16" height="10" />
  <path d="M42 10 L32 10 M32 2 L32 18" />
  <circle cx="20" cy="50" r="6" /> 
  <path d="M26 50 L40 50" />
  <path d="M70 50 L100 50" />
</svg>""",
    
    "mfc.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="25" y="25" width="50" height="50" rx="2" />
  <path d="M0 50 L25 50" />
  <path d="M75 50 L100 50" />
  <path d="M40 40 L60 60 M40 60 L60 40 Z" fill="#10b981" fill-opacity="0.1" />
  <line x1="50" y1="70" x2="50" y2="35" stroke-dasharray="2 2" />
  <polygon points="50,30 46,38 54,38" fill="#10b981" />
</svg>""",
    
    "mixer.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="25" y="25" width="50" height="50" rx="2" />
  <path d="M0 50 L25 50 M75 50 L100 50" />
  <path d="M35 45 L65 55 M35 55 L65 45" />
</svg>""",

    "combiner.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M0 10 L40 10 C 60 10 70 30 75 50 C 70 70 60 90 40 90 L0 90 Z" />
  <path d="M75 50 L100 50" />
</svg>""",
    
    "humidifier.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#0ea5e9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M0 50 L35 50 L35 85" />
  <circle cx="45" cy="80" r="2" fill="#0ea5e9" />
  <circle cx="55" cy="70" r="3" fill="#0ea5e9" />
  <circle cx="35" cy="65" r="1.5" fill="#0ea5e9" />
  <path d="M25 45 L25 85 A 10 10 0 0 0 35 95 L65 95 A 10 10 0 0 0 75 85 L75 45" />
  <path d="M25 45 Q 25 30 50 30 Q 75 30 75 45" />
  <path d="M45 15 L55 15 L55 30 L45 30 Z" />
  <path d="M75 50 L100 50" />
</svg>""",
    
    "y_splitter.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#a855f7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M0 50 L50 50" />
  <path d="M50 50 L50 0" />
  <path d="M50 50 L50 100" />
</svg>""",
    
    "output.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#ec4899" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M0 50 L20 50" />
  <rect x="20" y="20" width="70" height="60" rx="4" />
  <path d="M30 50 L40 50 L50 30 L60 70 L70 50 L80 50" />
</svg>"""
}

for name, content in svgs.items():
    with open(os.path.join(svg_dir, name), "w") as f:
        f.write(content)

print("done")
