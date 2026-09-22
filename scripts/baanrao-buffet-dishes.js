// Baan Rao — Sunday Buffet dishes as £0 buttons in category 18 (beside the
// Adult / Child price buttons) so staff can send each round to the kitchen.
// Mains carry the buffet meat choice (all £0 — it's all-you-can-eat).
const B = 'https://siamepos-baanrao-production.up.railway.app';
const CAT = 18;
const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const S = 1, M = 2;   // default_course: starter / main
const meat = ['Chicken', 'Pork', 'Beef', 'Vegetables (V)'];
const dishes = [
  ['1. Chicken Satay (N)', S, 'Chicken with curry powder and Thai herbs, grilled, with toast, cucumber relish and peanut sauce', ['Nuts']],
  ['2. Vegetable Spring Roll (V)', S, 'Deep-fried vegetable spring rolls with sweet chilli sauce'],
  ['3. Goong in Blanket', S, 'Deep-fried king prawns wrapped in pastry with chilli sauce'],
  ['4. Salt & Pepper Squid', S, 'Fresh squid in a light crispy salt-and-pepper coating with sriracha'],
  ['5. Prawns on Toast', S, 'Kha Nom Pang Na Goong — minced chicken and prawn on baguette with sweet chilli sauce'],
  ['6. See-Klong Moo in Honey', S, 'Tender roasted spare ribs marinated with honey sauce'],
  ['7. Chicken Wing with Season', S, 'Deep-fried chicken wings in special Thai seasoning with sweet chilli sauce'],
  ['8. Tempura (V)', S, 'Mixed vegetables deep-fried, with sweet chilli sauce'],
  ['9. Tod Man Khaw Poad (V)', S, 'Deep-fried sweet corn with red curry paste, with sweet chilli sauce'],
  ['10. Red Curry', M, 'Red chilli paste in coconut milk with courgette, bamboo shoots, peppers and sweet basil', null, meat],
  ['11. Green Curry', M, 'Medium-spicy green curry paste in coconut milk with courgette, bamboo shoots, peppers and sweet basil', null, meat],
  ['12. Pad King', M, 'Stir-fried fresh ginger, onion, spring onion and peppers with mushroom', null, meat],
  ['13. Pad Num Mune Hoy', M, 'Stir-fried onion, pepper and spring onion in oyster sauce', null, meat],
  ['14. Pad Pak Rom (V)', M, 'Stir-fried mixed vegetables'],
  ['15. Pad Pew Wan', M, 'Stir-fried pineapple, onion, peppers and spring onion in sweet and sour sauce', null, meat],
  ['16. Pad Kra Prow', M, 'Stir-fried garlic, chilli and oyster sauce with baby sweet corn, onion and basil', null, meat],
  ['17. Pad Boccori', M, 'Stir-fried broccoli', null, meat],
  ['18. Tom Yum Kai or Hed', M, 'Spicy Thai soup with lemongrass, galangal, chilli, spring onion, coriander and tomato', null, ['Chicken', 'Mushroom (V)']],
  ['19. Tom Kha Kai or Hed', M, 'Medium Thai soup with coconut cream, lemongrass and young galangal', null, ['Chicken', 'Mushroom (V)']],
  ['20. Lap Kai', M, 'Spicy salad of minced chicken with lime juice, fish sauce, dry chilli and mint, with fresh vegetables'],
  ['21. Pad Thai', M, 'Stir-fried rice noodles with sweet-and-sour tamarind sauce, egg, carrot, bean sprouts, spring onion, ground peanuts and lime', ['Nuts']],
  ['22. Steamed Rice', M, ''],
  ['23. Egg Fried Rice (Kaew Pad)', M, ''],
  ['24. Pad Mee', M, 'Plain egg noodles lightly flavoured with oyster sauce'],
  ['25. Chips', M, ''],
];
(async () => {
  for (const [name, course, description, allergens, opts] of dishes) {
    const r = await post('/api/menu/items', { category_id: CAT, name: 'Buffet — ' + name, description, price: 0, vat_rate: 20, default_course: course, allergens: allergens || null });
    if (!r.id) { console.log('FAILED', name, r); continue; }
    if (opts) {
      const g = await post(`/api/menu/items/${r.id}/modifiers`, { name: 'Choose your meat', required: true, multi_select: false });
      for (const o of opts) await post(`/api/modifier-groups/${g.id}/options`, { name: o, extra_price: 0 });
    }
    console.log('added', r.id, name, opts ? `(${opts.length} options)` : '');
  }
})();
