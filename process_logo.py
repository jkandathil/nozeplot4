from PIL import Image

def fix_logo():
    # Load original image
    # We will try to load the original 'logo.png' we saw in step 442 or 'logo_theme.png' if that was better quality
    # Step 442 showed 'logo.png' is a large teal circle with white logo.
    # We want the WHITE part to become #00DE93 and everything else TRANSPARENT.
    
    try:
        img = Image.open("src/assets/logo.png").convert("RGBA")
    except Exception as e:
        print(f"Error loading image: {e}")
        return

    width, height = img.size
    new_img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = new_img.load()
    orig_pixels = img.load()

    # Target color needed: #00DE93 -> (0, 222, 147)
    target_r, target_g, target_b = 0, 222, 147

    for x in range(width):
        for y in range(height):
            r, g, b, a = orig_pixels[x, y]
            
            # The original logo (step 442) has a teal circle background and WHITE logo.
            # We want to extract the WHITE logo.
            # White is roughly (255, 255, 255).
            # The teal background is roughly (0, 222, 147) or similar.
            
            # Let's say if pixel is "close to white", we make it #00DE93.
            # Anything not close to white (the teal circle) becomes transparent.
            
            # Simple threshold for white:
            if r > 200 and g > 200 and b > 200:
                # This is part of the white logo shape.
                # Keep alpha from original if needed (for antialiasing edges), 
                # but we need to set color to #00DE93.
                # However, edges might be blended with teal.
                
                # Better approach: Use the 'whiteness' as alpha for the new green logo.
                # Actually, in the original 'logo.png', the shape is WHITE on TEAL.
                # So (255,255,255) is full opacity logo.
                # Teal pixels are background.
                
                pixels[x, y] = (target_r, target_g, target_b, 255) # strict solid
                
                # To handle anti-aliasing:
                # If pixel is somewhat white but not fully, it might be an edge.
                # But simple threshold is often safer to avoid halo effects from the teal background.
            else:
                # Make it transparent
                pixels[x, y] = (0, 0, 0, 0)

    # Since simple thresholding might look jagged, let's try a smarter approach if possible.
    # The original image is high quality.
    # Finding the "white" mask.
    
    # Save result
    new_img.save("src/assets/logo_fixed.png", "PNG")
    print("Saved src/assets/logo_fixed.png")

if __name__ == "__main__":
    fix_logo()
