import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'
import path from 'path'

const OUT = '/home/z/my-project/upload'
const prompts: Array<[string, string]> = [
  ['seed-sneakers-white', 'Professional e-commerce product photography of a pair of white athletic running sneakers on a clean light gray studio background, soft shadows, centered, high quality, detailed'],
  ['seed-walking-shoes', 'Professional e-commerce product photography of a men\u2019s gray walking shoe, comfortable cushioned sole, clean light studio background, centered, high quality'],
  ['seed-headphones', 'Professional e-commerce product photography of sleek black wireless over-ear headphones on a minimal light background, studio lighting, high quality, detailed'],
  ['seed-powerbank', 'Professional e-commerce product photography of a slim modern black power bank with digital display and USB ports, clean white studio background, high quality'],
  ['seed-smartwatch', 'Professional e-commerce product photography of a modern smartwatch with black sport band and bright screen, clean light studio background, high quality'],
  ['seed-hoodie', 'Professional e-commerce product photography of a folded black hoodie sweatshirt on a light neutral background, clean studio shot, high quality'],
  ['seed-backpack', 'Professional e-commerce product photography of a modern dark gray laptop backpack standing on a light studio background, clean minimal, high quality'],
  ['seed-mug', 'Professional e-commerce product photography of a white ceramic thermal travel mug on a light background, clean minimal studio shot, high quality'],
  ['seed-sunglasses', 'Professional e-commerce product photography of stylish black sunglasses on a light beige background, minimal studio shot, high quality'],
  ['seed-notebook', 'Professional e-commerce product photography of a brown leather-bound notebook with elastic band on a light background, elegant minimal studio shot, high quality'],
]

async function main() {
  const zai = await ZAI.create()
  const results: string[] = []
  for (const [name, prompt] of prompts) {
    const out = path.join(OUT, `${name}.png`)
    if (fs.existsSync(out)) {
      results.push(`skip ${name}`)
      continue
    }
    try {
      const res = await zai.images.generations.create({ prompt, size: '1024x1024' })
      const b64 = res.data?.[0]?.base64
      if (!b64) throw new Error('no image data')
      fs.writeFileSync(out, Buffer.from(b64, 'base64'))
      results.push(`ok ${name}`)
      console.log(`ok ${name}`)
    } catch (e) {
      results.push(`fail ${name}: ${(e as Error).message}`)
      console.error(`fail ${name}`, (e as Error).message)
    }
  }
  fs.writeFileSync('/home/z/my-project/upload/.gen-results.json', JSON.stringify(results, null, 2))
  console.log('DONE')
}
main()
