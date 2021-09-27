/* eslint-disable  @typescript-eslint/no-explicit-any */
import { json } from 'co-body'
import SimpleCrypto from 'simple-crypto-js'
import { settings } from '../../constants'
import { getSkuWithVariations } from '../catalog'
import { getEncryptedNumber, mapItems } from '../utils/common'
import { formatError } from '../utils/error'

export async function generateInvoice(ctx: any, next: () => Promise<any>) {
  const body = await json(ctx.req)
  ctx.status = 200
  ctx.body = getEncryptedNumber(ctx, body)

  await next()
}

export async function showInvoice(ctx: any, next: () => Promise<any>) {
  const {
    clients: { smartbill },
  } = ctx

  const { invoiceNumber } = ctx.vtex.route.params
  const settings = await smartbill.getSettings()
  const simpleCrypto = new SimpleCrypto(settings.smarbillApiToken)
  const toDecrypt = Buffer.from(invoiceNumber, 'base64').toString('ascii')
  let plainNumber = simpleCrypto.decrypt(toDecrypt) as any

  plainNumber =
    typeof plainNumber === 'object' ? plainNumber.number : plainNumber

  const response = await smartbill.showInvoice(plainNumber.toString())

  ctx.status = 200

  ctx.body = response
  ctx.res.setHeader('Content-type', 'application/pdf')

  await next()
}

export async function processChanges(ctx: any, item: any, order: any) {
  if (item?.itemsAdded.length) {
    item.itemsAdded.map(async (added: any) => {
      const existingProduct = order?.items.filter((it: any) => {
        return it.id === added.id
      })
      let imageUrl = ''
      if (!existingProduct.length) {
        const { sku, existingSku } = await getSkuWithVariations(
          added.id.toString(),
          ctx
        )
        if (existingSku.length) {
          imageUrl = existingSku[0].image
        }
        order.items.push(mapItems(sku, added, imageUrl))
      } else {
        const index = order.items.indexOf(existingProduct[0])
        if (index !== -1) {
          order.items[index].quantity += added.quantity
        }
      }
    })
  }
  if (item?.itemsRemoved?.length) {
    removeItems(item.itemsRemoved, order)
  }
}

export async function saveInvoice(ctx: any, next: () => Promise<any>) {
  const {
    clients: { oms, logger },
  } = ctx

  const { orderId } = ctx.vtex.route.params
  let order: any
  try {
    order = await oms.getOrderId(orderId)
  } catch (e) {
    logger.error({
      message: 'SAVE-INVOICE-ERROR',
      error: formatError(e),
    })
    ctx.status = 500
    ctx.body = e.response

    return
  }

  if (order?.status === 'invoiced') {
    ctx.status = 400
    ctx.body = 'Order already invoiced'

    return
  }
  if (order?.changesAttachment) {
    order?.changesAttachment?.changesData.map(async function(item: any) {
      await processChanges(ctx, item, order)
    })
  }

  const ship = order?.totals?.filter(function(item: any) {
    return item.id === settings.constants.shipping
  })
  const shipping = ship.length ? ship[0].value : 0

  order = {
    ...order,
    shippingTotal: shipping / settings.constants.price_multiplier,
    items: order.items.map((item: any) => {
      return {
        ...item,
        sellingPrice:
          (item.sellingPrice + item.tax) / settings.constants.price_multiplier,
      }
    }),
  }
  const { number, encryptedNumber } = await getEncryptedNumber(ctx, { order })

  const url = `https://${ctx.vtex.account}.myvtex.com/smartbill/show-invoice/${encryptedNumber}`

  const data = {
    invoiceNumber: number,
    invoiceValue: order.value,
    issuanceDate: new Date().toISOString(),
    invoiceUrl: url,
    items: order.items.map((item: any) => {
      return {
        id: item.productId,
        price: item.sellingPrice,
        quantity: item.quantity,
      }
    }),
  }
  try {
    await oms.postInvoice(orderId, data)
  } catch (e) {
    logger.error({
      middleware: 'SAVE-INVOICE',
      error: formatError(e),
    })
    ctx.status = 500
    ctx.body = formatError(e)
  }

  ctx.status = 200
  ctx.body = {
    invoiceNumber: number,
    invoiceDate: data.issuanceDate,
    invoiceUrl: data.invoiceUrl,
  }

  await next()
}

export async function removeItems(itemsToRemove: any, order: any) {
  itemsToRemove.map((removed: any) => {
    const existingRemovedProduct = order?.items.filter((it: any) => {
      return it.id === removed.id
    })

    if (existingRemovedProduct.length) {
      if (existingRemovedProduct[0].quantity - removed.quantity == 0) {
        const index = order?.items.indexOf(existingRemovedProduct[0])

        if (index !== -1) {
          order?.items.splice(index, 1)
        }
      }
    }
  })
}
