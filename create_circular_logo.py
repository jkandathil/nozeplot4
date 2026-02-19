from PIL import Image, ImageDraw

def create_circular_logo():
    # 1. Settings
    size = (512, 512)
    bg_color = (0, 222, 147, 255) # #00DE93
    icon_color = (255, 255, 255, 255) # White
    
    # 2. Create base image (Transparent)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 3. Draw Green Circle
    # Leave a small margin for smoothness
    margin = 2
    draw.ellipse([margin, margin, size[0]-margin, size[1]-margin], fill=bg_color)
    
    # 4. Load the teardrop shape (logo_fixed.png)
    # This image is practically the shape we want, currently green on transparent.
    try:
        icon_src = Image.open("src/assets/logo_fixed.png").convert("RGBA")
    except Exception as e:
        print(f"Error loading icon: {e}")
        return

    # 5. Resize icon to fit inside the circle
    # Original is likely close to square. Let's make it about 60% of the circle size.
    target_icon_size = int(size[0] * 0.6)
    icon_aspect = icon_src.width / icon_src.height
    new_w = target_icon_size
    new_h = int(target_icon_size / icon_aspect)
    
    icon_resized = icon_src.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    # 6. Recolor the icon to White
    # Create a white block of the same size
    white_block = Image.new("RGBA", icon_resized.size, icon_color)
    # Use the icon's alpha channel as mask to paste white block
    # But first, we need to ensure icon_resized only has the shape.
    # We can use icon_resized as the mask itself if we extract alpha.
    
    # Paste White Icon onto Green Circle
    # Center position
    pos_x = (size[0] - new_w) // 2
    pos_y = (size[1] - new_h) // 2
    
    # We paste 'white_block' using 'icon_resized' (alpha) as mask
    img.paste(white_block, (pos_x, pos_y), icon_resized)
    
    # 7. Save
    img.save("src/assets/logo_circular.png", "PNG")
    print("Saved src/assets/logo_circular.png")

if __name__ == "__main__":
    create_circular_logo()
