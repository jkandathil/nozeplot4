import os
import glob
import re

files = [
    'src/components/CSVPlotterPage.jsx',
    'src/components/gas-design/GasSystemDesignPage.jsx',
    'src/components/MLStudioPage.jsx',
    'src/components/GasDilutionMathPage.jsx',
    'src/components/ManufacturingVariationPage.jsx',
    'src/components/SeparabilityAnalysisPage.jsx',
    'src/components/AromaAnalysisPage.jsx',
    'src/components/RecoveryAnalysisPage.jsx'
]

for file_path in files:
    if not os.path.exists(file_path):
        continue
    with open(file_path, 'r') as f:
        content = f.read()

    # 1. Add AnimatePresence to imports
    if 'AnimatePresence' not in content:
        content = re.sub(r'import\s+{\s*motion\s*}\s+from\s+[\'"]framer-motion[\'"];', r'import { motion, AnimatePresence } from "framer-motion";', content)
        if 'AnimatePresence' not in content:
            content = re.sub(r'import\s+{\s*(.*?)\s*}\s+from\s+[\'"]framer-motion[\'"]', r'import { \1, AnimatePresence } from "framer-motion"', content)

    # 2. Add <AnimatePresence> wrapping
    content = content.replace('{isSidebarVisible && (', '<AnimatePresence>{isSidebarVisible && (')

    # 3. Replace <div className="config-panel... with motion.div
    # For CSVPlotterPage:
    content = re.sub(r'<div\s+className="sidebar-controls.*?>', r'<motion.div initial={{ width: 0, opacity: 0 }} animate={{ width: sidebarWidth, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.5, ease: "easeInOut" }} className="sidebar-controls glass-panel" style={{ overflow: "hidden", whiteSpace: "nowrap" }}>', content)

    # General replacements for others:
    content = re.sub(
        r'<div\s+className="([^"]*(?:config-panel|sidebar-panel|toolbox-panel|input-section)[^"]*)"\s*style=\{\{\s*(?:width:\s*sidebarWidth\s*,\s*)?position:\s*\'relative\'\s*\}\}\>',
        r'<motion.div initial={{ width: 0, opacity: 0 }} animate={{ width: sidebarWidth || 500, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.5, ease: "easeInOut" }} className="\1" style={{ position: "relative", overflow: "hidden", whiteSpace: "nowrap" }}>',
        content)

    content = re.sub(
        r'<div\s+className="([^"]*(?:config-panel|sidebar-panel|toolbox-panel|input-section)[^"]*)"\>',
        r'<motion.div initial={{ width: 0, opacity: 0 }} animate={{ width: sidebarWidth || 500, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.5, ease: "easeInOut" }} className="\1" style={{ overflow: "hidden", whiteSpace: "nowrap" }}>',
        content)

    # Close the AnimatePresence where there's  )} under it. 
    # This is trickier, we need to match `)}` that closes `{isSidebarVisible && (`
    content = re.sub(r'\)\}\s*(?=<\/?div)', r')}</AnimatePresence>\n', content)

    # Replace closing </div> with </motion.div> for those classes. This is too risky with regex.
    # I should just write precise python blocks matching the exact HTML structure or use standard replace.
