// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const asyncMiddleware = require('../middleware/asyncMiddleware')
const express = require('express')
const router = express.Router()
const utils = require('../lib/utils')
const Curation = require('../lib/curation')
const EntityCoordinates = require('../lib/entityCoordinates')
const { permissionsCheck } = require('../middleware/permissions')

// Get a proposed patch for a specific revision of a component
router.get('/:type/:provider/:namespace/:name/:revision/pr/:pr', asyncMiddleware(getChangesForCoordinatesInPr))

async function getChangesForCoordinatesInPr(request, response) {
  const coordinates = await utils.toEntityCoordinatesFromRequest(request)
  const result = await curationService.get(coordinates, request.params.pr)
  if (result) return response.status(200).send(result)
  response.sendStatus(404)
}

// Get data needed by review UI
router.get('/pr/:pr', asyncMiddleware(getPr))

async function getPr(request, response) {
  try {
    const url = curationService.getCurationUrl(request.params.pr)
    const changes = await curationService.getChangedDefinitions(request.params.pr)
    return response.status(200).send({ url, changes })
  } catch (exception) {
    if (exception.code === 404) return response.sendStatus(404)
    throw exception
  }
}

// Get an existing patch for a specific revision of a component
router.get('/:type/:provider/:namespace/:name/:revision', asyncMiddleware(getCurationForCoordinates))

async function getCurationForCoordinates(request, response) {
  if (request.query.expand === 'prs') return listCurations(request, response)
  const coordinates = await utils.toEntityCoordinatesFromRequest(request)
  const result = await curationService.get(coordinates)
  if (!result) return response.sendStatus(404)
  return response.status(200).send(result)
}

// Search for any patches related to the given path, as much as is given
router.get('/:type?/:provider?/:namespace?/:name?', asyncMiddleware(listCurations))

async function listCurations(request, response) {
  const coordinates = await utils.toEntityCoordinatesFromRequest(request)
  const result = await curationService.list(coordinates)
  if (!result || !result.contributions.length) return response.sendStatus(404)
  return response.status(200).send(result)
}

router.post('/', asyncMiddleware(listAllCurations))

async function listAllCurations(request, response) {
  const coordinatesList = request.body.map(entry => EntityCoordinates.fromString(entry))
  if (coordinatesList.length > 1000)
    return response.status(400).send(`Body contains too many coordinates: ${coordinatesList.length}`)
  const normalizedCoordinatesList = await Promise.all(coordinatesList.map(utils.toNormalizedEntityCoordinates))

  const result = await curationService.listAll(normalizedCoordinatesList)
  response.send(result)
}

router.patch('', asyncMiddleware(updateCurations))

async function updateCurations(request, response) {
  const serviceGithub = request.app.locals.service.github.client
  const userGithub = request.app.locals.user.github.client
  const info = await request.app.locals.user.github.getInfo()
  let curationErrors = []
  let patchesInError = []
  request.body.patches.forEach(entry => {
    const curation = new Curation(entry)
    if (curation.errors.length > 0) curationErrors = [...curationErrors, curation.errors]
    patchesInError.push(entry)
  })
  if (curationErrors.length > 0) {
    const errorData = { errors: curationErrors, patchesInError }
    logger.error('intended curations are invalid', errorData)
    return response.status(400).send(errorData)
  }

  const normalizedPatches = await Promise.all(request.body.patches.map(async entry => {
    return { ...entry, coordinates: await utils.toNormalizedEntityCoordinates(entry.coordinates) }
  }))
  const normalizedBody = { ...request.body, patches: normalizedPatches }
  const result = await curationService.addOrUpdate(userGithub, serviceGithub, info, normalizedBody)
  response.status(200).send({
    prNumber: result.data.number,
    url: curationService.getCurationUrl(result.data.number)
  })
}

router.post('/sync', permissionsCheck('curate'), asyncMiddleware(syncAllContributions))

async function syncAllContributions(request, response) {
  const userGithub = request.app.locals.user.github.client
  if (!userGithub) {
    return response.status(400).send('Invalid Github user')
  }

  await curationService.syncAllContributions(userGithub)
  response.send({ status: 'OK' })
}

router.post('/reprocess', permissionsCheck('curate'), asyncMiddleware(reprocessMergedCurations))

async function reprocessMergedCurations(request, respond) {
  const coordinatesArray = request.body.map(EntityCoordinates.fromString)
  // Reprocess consume a lot of resource. Limit the size of the reprocess request.
  const reprocessThreshold = 100
  if (coordinatesArray.length >= reprocessThreshold) {
    return respond.status(403).send({ message: `Reprocess coordinates number exceed ${reprocessThreshold} threshold.` })
  }
  const normalizedCoordinatesList = await Promise.all(coordinatesArray.map(utils.toNormalizedEntityCoordinates))
  const result = await curationService.reprocessMergedCurations(normalizedCoordinatesList)
  respond.status(200).send(result)
}

let curationService
let logger

function setup(service, appLogger) {
  curationService = service
  logger = appLogger || require('../providers/logging/logger')()
  return router
}

module.exports = setup
