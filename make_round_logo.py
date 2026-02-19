from PIL import Image, ImageDraw, ImageOps

def make_round_logo():
    input_path = "public/logo_noze.png"
    output_path = "public/logo_noze_circle.png"

    try:
        img = Image.open(input_path).convert("RGBA")
    except Exception as e:
        print(f"Error opening image: {e}")
        return

    # 1. Square crop
    min_dim = min(img.size)
    # create a square canvas
    # or just crop center
    
    # Calculate crop box
    left = (img.width - min_dim) / 2
    top = (img.height - min_dim) / 2
    right = (img.width + min_dim) / 2
    bottom = (img.height + min_dim) / 2

    img = img.crop((left, top, right, bottom))
    
    # 2. Create circular mask
    mask = Image.new('L', img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, img.size[0], img.size[1]), fill=255)

    # 3. Apply mask
    result = Image.new('RGBA', img.size, (0, 0, 0, 0))
    result.paste(img, (0, 0), mask=mask)

    result.save(output_path)
    print(f"Saved {output_path}")

if __name__ == "__main__":
    make_round_logo()
