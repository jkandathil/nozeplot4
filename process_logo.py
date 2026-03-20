import os
from PIL import Image

def fix_logo():
    # 1. Resolve absolute paths based on the script's location
    base_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(base_dir, "src", "assets", "logo.png")
    output_path = os.path.join(base_dir, "src", "assets", "logo_fixed.png")

    try:
        img = Image.open(input_path).convert("RGBA")
    except Exception as e:
        print(f"Error loading image: {e}")
        return

    # Target color needed: #00DE93 -> (0, 222, 147)
    target_r, target_g, target_b = 0, 222, 147

    # 2. Extract pixel data into a flat list (Much faster than nested for loops)
    pixel_data = img.getdata()
    new_pixels = []

    for r, g, b, a in pixel_data:
        # Ignore completely transparent pixels
        if a == 0:
            new_pixels.append((0, 0, 0, 0))
            continue
            
        # Determine how "white" the pixel is.
        # White is perfectly (255, 255, 255)
        # We take the minimumRGB channel value to track distance from Teal (0, 222, 147).
        # Pure teal will be 0. Pure white will be 255.
        whiteness = min(r, g, b)
        
        # 3. Soft threshold to preserve Anti-aliasing edges!
        if whiteness > 200:
            # Solid white text core -> make it solid target green, keeping its original alpha
            new_pixels.append((target_r, target_g, target_b, a))
        elif whiteness > 50:
            # Soft edge pixels between white and teal -> map whiteness smoothly into alpha
            blended_alpha = int(((whiteness - 50) / 150.0) * a)
            new_pixels.append((target_r, target_g, target_b, blended_alpha))
        else:
            # Core teal background -> force transparency
            new_pixels.append((0, 0, 0, 0))

    # Compile the final processed image array
    new_img = Image.new("RGBA", img.size)
    new_img.putdata(new_pixels)

    # Save result
    new_img.save(output_path, "PNG")
    print(f"Saved {output_path}")

if __name__ == "__main__":
    fix_logo()
