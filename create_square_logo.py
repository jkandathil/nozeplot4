from PIL import Image, ImageDraw

def create_square_logo():
    # 1. Settings
    size = (512, 512)
    bg_color = (0, 222, 147, 255) # #00DE93
    icon_color = (255, 255, 255, 255) # White
    
    # 2. Create base image (Solid Green)
    img = Image.new("RGBA", size, bg_color)
    
    # 3. Load the teardrop shape (logo_fixed.png)
    # This image is the green teardrop on transparent.
    try:
        icon_src = Image.open("src/assets/logo_fixed.png").convert("RGBA")
    except Exception as e:
        print(f"Error loading icon: {e}")
        return

    # 4. Resize icon to fit nicely inside the square
    # Make it about 60% of size
    target_icon_size = int(size[0] * 0.6)
    icon_aspect = icon_src.width / icon_src.height
    new_w = target_icon_size
    new_h = int(target_icon_size / icon_aspect)
    
    icon_resized = icon_src.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    # 5. Create White version of the icon
    white_block = Image.new("RGBA", icon_resized.size, icon_color)
    
    # 6. Paste White Icon onto Green Square
    # Center position
    pos_x = (size[0] - new_w) // 2
    pos_y = (size[1] - new_h) // 2
    
    # Paste using icon alpha as mask
    img.paste(white_block, (pos_x, pos_y), icon_resized)
    
    # 7. Save
    img.save("src/assets/logo_square.png", "PNG")
    print("Saved src/assets/logo_square.png")

if __name__ == "__main__":
    create_square_logo()
