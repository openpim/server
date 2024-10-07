try {
    let productPrice
    let productRemain
    const item = await models.item.findOne({where: {id: itemRelation.itemId}})
    const relsSP = await models.itemRelation.findAll({where: {relationIdentifier: 'SupplierProduct', itemIdentifier: item.identifier}})
    const SupplierIDs = relsSP.map(rel => rel.values.relAttrSupplierId)
    const Suppliers = await models.item.findAll({where: {id:{[Op.in]:SupplierIDs}}})
  
    for (const relSP of relsSP) {
      let spPrice
      let spKoeff
      let relPrice
      let spPrice2
      const Supplier = Suppliers.find(s => s.id == relSP.values?.relAttrSupplierId)
      if (Supplier && Supplier.values && Supplier.values.koeffPrice && relSP.values && relSP.values.relAttrPrice) {
        spPrice = relSP.values.relAttrPrice
        spPrice2 = relSP.values.relAttrPrice2
        spKoeff = Supplier.values.koeffPrice
        relPrice = Math.round(((spPrice * spKoeff)+ Number.EPSILON) * 100) / 100
        if (!productPrice) {
          productPrice = relPrice 
          productPrice2 = spPrice2
          productRemain = relSP.values.relAttrRemain        
        } else if (relPrice < productPrice) {
          productPrice = relPrice 
          productPrice2 = spPrice2 
          productRemain = relSP.values.relAttrRemain
        }
      }
    }
    item.values.pPrice = productPrice 
    item.values.pPrice2 = productPrice2 
    item.values.pRemain = productRemain
    item.changed('values', true)
    await item.save()
  } catch (err) {
    console.error(err.message)
  }