const TARGET_COLLECTIONS = [
  'Alfombras y tapicerías',
  'Espejos',
  'Lámparas y apliques',
  'Cómodas y tocadores',
  'Escritorios, secretaires y chiffoniers',
  'Mesas de comedor',
  'Mesas de centro y de apoyo',
  'Mesas de juego, costureros, bar y más',
  'Sillas, sillones y sitiales',
  'Veladores',
  'Vitrinas, libreros y estantes',
  'Mármoles',
  'Fierros',
  'Chilena contemporánea',
  'Chilena clásica',
  'Europea clásica',
  'Extranjera contemporánea',
  'Religiosa',
];

function getContext(collectionTitle, productTitle, metafields = {}) {
  const t    = (productTitle || '').toLowerCase();
  const alto = parseFloat(metafields.alto);

  switch (collectionTitle) {
    case 'Alfombras y tapicerías':
      if (/tapiz|tapicería/.test(t))
        return 'hung on the wall of a contemporary elegant living room';
      return 'laid on the floor of a spacious modern living room with a neutral sofa and natural light';
    case 'Espejos':
      if (alto > 130) return 'leaning against or mounted on a full wall in a modern luminous living room or bedroom, floor-to-ceiling scale';
      if (alto > 80)  return 'mounted on the wall of a modern luminous bedroom or hallway';
      return 'above a console table in a modern luminous entrance hall or bedroom';
    case 'Lámparas y apliques':
      if (/aplique/.test(t))
        return 'mounted on the wall of a contemporary bedroom hallway with warm ambient light';
      if (/mesa|velador/.test(t))
        return 'on a bedside table or desk in a modern luminous bedroom';
      return 'hanging from the ceiling of a contemporary elegant dining room or living room';
    case 'Cómodas y tocadores':
      return 'in a contemporary luminous bedroom with natural light streaming in';
    case 'Escritorios, secretaires y chiffoniers':
      return 'in an elegant and tidy home study or office with natural light';
    case 'Mesas de comedor':
      return 'in a luminous elegant family dining room with chairs arranged around it';
    case 'Mesas de centro y de apoyo':
      return 'in a modern living room with a neutral sofa and a light rug';
    case 'Mesas de juego, costureros, bar y más':
      return 'in a contemporary elegant living room or sitting area';
    case 'Sillas, sillones y sitiales':
      return 'in a contemporary living room or dining room with natural light';
    case 'Veladores':
      return 'next to a bed in a modern luminous bedroom with soft warm lighting';
    case 'Vitrinas, libreros y estantes':
      return 'in a contemporary tidy living room or study, elegantly styled';
    case 'Mármoles':
      return 'in a garden or outdoor terrace with lush green vegetation';
    case 'Fierros':
      return 'in a contemporary garden or outdoor terrace with clean architectural lines';
    case 'Chilena contemporánea':
      return 'on the wall of a contemporary luminous living room with neutral furniture';
    case 'Chilena clásica':
      return 'on the wall of an elegant classic salon with warm light and rich textures';
    case 'Europea clásica':
      return 'on the wall of a classic European salon with ornate moldings and warm light';
    case 'Extranjera contemporánea':
      return 'on the wall of a modern minimalist living room with clean lines';
    case 'Religiosa':
      return 'on the wall of a chapel or classic salon with warm reverent light';
    default:
      return 'in an elegant contemporary home interior with natural light';
  }
}

function getSizeDescription(alto, ancho, collectionTitle) {
  const wallArtCollections = [
    'Chilena contemporánea', 'Chilena clásica', 'Europea clásica',
    'Extranjera contemporánea', 'Religiosa', 'Alfombras y tapicerías',
  ];
  const isWallArt = wallArtCollections.includes(collectionTitle);
  const ref = isWallArt ? parseFloat(ancho) : parseFloat(alto);
  if (!ref || isNaN(ref)) return null;
  if (ref < 50)  return 'small, delicate piece that appears intimate in scale';
  if (ref <= 120) return 'medium sized piece with a notable presence in the room';
  return 'large, visually dominant piece that anchors the space';
}

module.exports = { TARGET_COLLECTIONS, getContext, getSizeDescription };
